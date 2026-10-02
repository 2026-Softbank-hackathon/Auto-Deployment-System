import { createHash } from "node:crypto";
import path from "node:path";
import {
  createDeploymentPlan,
  AdapterError,
  type OnpremDockerDeploymentPlan,
} from "@camellia/adapters";
import { AwsConfigSchema, PLATFORM_INJECTED_ENV_NAMES } from "@camellia/contracts";
import { IrSchema } from "@camellia/ir-schema";
import type { WorkerDeps } from "../deps.js";
import { createStepLogger } from "../step-log.js";
import { transitionTo, type Status } from "../state-machine.js";
import { TerraformCliError, type TerraformOutputs, type TerraformVariable } from "../terraform-cli.js";
import { OriginActivationError } from "../origin-activation.js";
import { EcsRolloutError } from "../ecs-rollout.js";

export type ProvisionJobPayload = {
  deployment_id: number | string;
};

type ProvisionContext = {
  status: Status;
  project_id: number | string;
  target_profile: string | null;
  target_environment_id: number | string | null;
  target_environment_type: string | null;
  /** 대상 연결의 소유 프로젝트 — 공용 연결(#215)이면 null */
  target_environment_project_id: number | string | null;
  aws_config: unknown;
  ir_json: unknown;
  repository_uri: string | null;
  immutable_ref: string | null;
  image_digest: string | null;
  image_platform: string | null;
  origin_url: string | null;
};

type ProjectEnvironmentVariable = {
  name: string;
  value: string;
};

export async function handleProvision(
  job: { data: ProvisionJobPayload },
  deps: WorkerDeps,
): Promise<void> {
  const deploymentId = parsePositiveId(job.data.deployment_id, "DEPLOYMENT_ID_INVALID");
  const stepLog = createStepLogger(deps, deploymentId, "provision");
  let activeStatus: Status | null = null;

  try {
    const context = await loadProvisionContext(deps, deploymentId);
    activeStatus = context.status;

    if (["verifying", "succeeded", "failed", "cancelled", "rejected"].includes(context.status)) return;
    if (context.status !== "provisioning" && context.status !== "deploying") {
      throw new Error("PROVISION_STATE_INVALID");
    }

    const projectId = parsePositiveId(context.project_id, "PROJECT_ID_INVALID");
    const environmentId = parsePositiveId(
      context.target_environment_id,
      "TARGET_ENVIRONMENT_REQUIRED",
    );
    if (!context.target_profile) throw new Error("TARGET_PROFILE_MISSING");
    if (
      !context.repository_uri ||
      !context.immutable_ref ||
      !context.image_digest ||
      !context.image_platform
    ) {
      throw new Error("BUILD_ARTIFACT_MISSING");
    }

    const ir = IrSchema.parse(context.ir_json);
    const plan = createDeploymentPlan(ir, context.target_profile);
    if (plan.service.secretNames.length > 0) {
      throw new Error("APPLICATION_SECRET_DELIVERY_UNAVAILABLE");
    }

    // 플랫폼 자동 주입용 region 미리 결정 (분기별로 다른 소스).
    let platformRegion: string;
    if (plan.target === "onprem") {
      platformRegion = ecrRegionFromRepository(context.repository_uri);
    } else if (plan.target === "aws" && context.target_environment_type === "aws") {
      platformRegion = AwsConfigSchema.parse(context.aws_config).region;
    } else {
      throw new Error("PROVISION_TARGET_UNSUPPORTED");
    }

    const environmentVariables = await loadProjectEnvironmentVariables(
      deps,
      projectId,
      plan.service.environmentNames,
      plan.service.environmentDefaults,
      {
        containerPort: plan.service.containerPort,
        deployTarget: plan.target,
        region: platformRegion,
      },
    );

    if (plan.target === "onprem") {
      if (context.target_environment_type !== "onprem") {
        throw new Error("PROVISION_TARGET_UNSUPPORTED");
      }
      const region = ecrRegionFromRepository(context.repository_uri);
      if (!deps.originActivator) {
        throw new OriginActivationError("ORIGIN_CONFIGURATION_MISSING");
      }
      await deps.originActivator.prepareOnpremVerification({
        deploymentId,
        projectId,
      });
      await stepLog.line("검증용 DNS 사전 준비 완료");
      await createOrGetOnpremAgentJob(deps, {
        jobId: String(deploymentId),
        attempt: 1,
        deploymentId,
        environmentId: String(environmentId),
        plan,
        image: {
          repositoryUri: context.repository_uri,
          digest: context.image_digest,
          platform: normalizeImagePlatform(context.image_platform),
          registryType: "ecr",
          region,
        },
        ...(Object.keys(environmentVariables).length > 0
          ? { environment: environmentVariables }
          : {}),
      });
      if (context.status === "provisioning") {
        await transitionTo(deps.pool, deploymentId, "deploying");
        activeStatus = "deploying";
        await deps.notifier?.notify(deploymentId, "state_changed", {
          status: "deploying",
        });
      }
      await stepLog.line("On-Prem Agent Job 저장 완료, Agent 실행을 기다립니다.");
      return;
    }

    if (plan.target !== "aws" || context.target_environment_type !== "aws") {
      throw new Error("PROVISION_TARGET_UNSUPPORTED");
    }
    if (
      !deps.secretReader ||
      !deps.terraformCli ||
      !deps.terraformBackend ||
      !deps.terraformModuleRoot ||
      !deps.ecsRolloutWaiter
    ) {
      throw new Error("TERRAFORM_DEPENDENCY_MISSING");
    }
    const awsConfig = AwsConfigSchema.parse(context.aws_config);
    if (
      awsConfig.credentialsType !== "access_key" ||
      !awsConfig.accessKeyIdSecretName ||
      !awsConfig.secretAccessKeySecretName
    ) {
      throw new Error("AWS_CREDENTIALS_UNSUPPORTED");
    }
    // 시크릿은 대상 연결의 소유 범위에서 읽는다 (공용 연결이면 공용 시크릿, #215).
    // Terraform state key · 리소스 이름은 아래처럼 배포 프로젝트 기준이라 앱끼리 겹치지 않는다.
    const secretOwnerId =
      context.target_environment_project_id === null
        ? null
        : parsePositiveId(context.target_environment_project_id, "PROJECT_ID_INVALID");
    const [accessKeyId, secretAccessKey] = await Promise.all([
      deps.secretReader.read(secretOwnerId, awsConfig.accessKeyIdSecretName),
      deps.secretReader.read(secretOwnerId, awsConfig.secretAccessKeySecretName),
    ]);

    const moduleDirectory = path.resolve(
      deps.terraformModuleRoot,
      plan.provisioning.moduleRef.replace(/^infra\/terraform\/profiles\//, ""),
    );
    if (!moduleDirectory.startsWith(`${path.resolve(deps.terraformModuleRoot)}${path.sep}`)) {
      throw new Error("TERRAFORM_MODULE_INVALID");
    }

    const stateKey = terraformStateKey(projectId, environmentId);
    const resourceName = resourceNameFor(projectId, environmentId);
    const applied = context.status === "deploying" && context.origin_url
      ? { originUrl: context.origin_url, outputs: {} as TerraformOutputs }
      : await applyTerraform({
          deps,
          stepLog,
          deploymentId,
          projectId,
          environmentId,
          moduleDirectory,
          stateKey,
          resourceName,
          variables: {
            ...plan.provisioning.variables,
            app_name: safeContainerName(plan.application.name),
            region: awsConfig.region,
            resource_name: resourceName,
            container_image: context.immutable_ref,
            environment_variables: environmentVariables,
            secret_references: {},
          },
          credentials: { accessKeyId, secretAccessKey },
          region: awsConfig.region,
        });
    const originUrl = applied.originUrl;

    validateOriginUrl(originUrl);
    await deps.pool.query(
      "UPDATE deployments SET public_url = $1, updated_at = NOW() WHERE id = $2",
      [originUrl, deploymentId],
    );

    if (context.status === "provisioning") {
      await transitionTo(deps.pool, deploymentId, "deploying");
      activeStatus = "deploying";
      await deps.notifier?.notify(deploymentId, "state_changed", {
        status: "deploying",
      });
    }

    // Terraform 은 서비스 갱신만 하고 돌아온다 (wait_for_steady_state = false, #253).
    // 롤아웃 완료를 여기서 기다린 뒤 최종 검증으로 넘긴다. 재시도로 apply 를 건너뛴 경우에도 다시 확인한다.
    await deps.ecsRolloutWaiter.wait({
      region: awsConfig.region,
      credentials: { accessKeyId, secretAccessKey },
      clusterName: stringOutput(applied.outputs, "cluster_name") ?? resourceName,
      serviceName: stringOutput(applied.outputs, "service_name") ?? resourceName,
      expectedImage: context.immutable_ref,
      log: (line) => stepLog.line(line),
    });

    await transitionTo(deps.pool, deploymentId, "verifying");
    activeStatus = "verifying";
    await deps.notifier?.notify(deploymentId, "state_changed", {
      status: "verifying",
    });
    await stepLog.line("ECS 롤아웃 완료, 헬스체크 검증을 시작합니다.");
    await deps.boss.send("verify", {
      jobId: `verify-deployment-${deploymentId}`,
      attempt: 1,
      deploymentId,
      environmentId: String(environmentId),
      environmentType: "aws",
      serviceId: plan.service.name,
      targetUrl: originUrl,
      health: {
        path: plan.health.path,
        expectedStatus: plan.health.expectedStatus,
        timeoutMs: plan.health.timeoutSeconds * 1000,
      },
      expectedDigest: context.image_digest,
    });
  } catch (error) {
    const errorCode = normalizeProvisionFailure(error);
    const errorDetail =
      (error instanceof TerraformCliError || error instanceof EcsRolloutError) && error.detail
        ? error.detail.slice(0, 2048)
        : undefined;
    deps.log?.error(
      { deployment_id: deploymentId, error_code: errorCode },
      "provision job failed",
    );
    await stepLog.line(`프로비저닝 실패: ${errorCode}`);
    if (errorDetail) {
      await stepLog.line(errorDetail);
    }

    if (
      activeStatus === "planning" ||
      activeStatus === "provisioning" ||
      activeStatus === "deploying" ||
      activeStatus === "verifying"
    ) {
      const failed = await failProvisionStage(deps, deploymentId, activeStatus, errorCode, errorDetail);
      if (!failed) throw error;
      await deps.boss.send("diagnose", { deployment_id: deploymentId }).catch(() => {});
      await deps.notifier?.notify(deploymentId, "state_changed", {
        status: "failed",
      });
      return;
    }
    throw error;
  }
}

async function failProvisionStage(
  deps: WorkerDeps,
  deploymentId: number,
  expectedStatus: Status,
  errorCode: string,
  errorDetail?: string,
): Promise<boolean> {
  const errorValue = errorDetail
    ? `${errorCode}\n${errorDetail.slice(0, 2048)}`
    : errorCode;
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ id: number | string }>(
      `UPDATE deployments
       SET status = 'failed', error = $1, failed_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = $3
       RETURNING id`,
      [errorValue, deploymentId, expectedStatus],
    );
    if (result.rows.length > 0) {
      await client.query("DELETE FROM env_locks WHERE deployment_id = $1", [deploymentId]);
    }
    await client.query("COMMIT");
    return result.rows.length > 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function applyTerraform(input: {
  deps: WorkerDeps;
  stepLog: ReturnType<typeof createStepLogger>;
  deploymentId: number;
  projectId: number;
  environmentId: number;
  moduleDirectory: string;
  stateKey: string;
  resourceName: string;
  variables: Record<string, string | number | boolean | Record<string, string>>;
  credentials: { accessKeyId: string; secretAccessKey: string };
  region: string;
}): Promise<{ originUrl: string; outputs: TerraformOutputs }> {
  const { deps } = input;
  const refresh = await decideStateRefresh(input);
  await input.stepLog.line("Terraform 실행 시작");
  try {
    const outputs = await deps.terraformCli!.apply({
      moduleDirectory: input.moduleDirectory,
      backend: {
        ...deps.terraformBackend!,
        stateKey: input.stateKey,
      },
      region: input.region,
      credentials: input.credentials,
      variables: input.variables,
      log: (line) => input.stepLog.line(line),
      refresh,
    });
    const originUrl = outputs["origin_url"]?.value;
    if (typeof originUrl !== "string") {
      throw new Error("TERRAFORM_OUTPUT_MISSING");
    }
    await input.stepLog.line("Terraform apply 완료, origin endpoint를 수집했습니다.");
    return { originUrl, outputs };
  } catch (error) {
    if (error instanceof TerraformCliError) throw error;
    if (error instanceof AdapterError) throw error;
    if (error instanceof Error && error.message === "TERRAFORM_OUTPUT_MISSING") {
      throw error;
    }
    throw new Error("TERRAFORM_APPLY_FAILED");
  }
}

/**
 * 이미지만 바뀐 재배포의 상태 재조회 생략 (#252, 팀 합의 2026-10-02).
 * 이미지를 뺀 Terraform 입력(모듈 파일 · 변수 · region · access key ID)의 지문이 같은 프로젝트 · 환경에서
 * 직전에 Terraform 을 돌린 배포와 같고 그 배포가 성공했을 때만 -refresh=false 로 하고,
 * 이때는 plan · apply 를 apply 한 번으로 합친다 (#260).
 * 지문은 apply 전에 이번 배포에 기록한다 → apply 나 검증이 실패하면(ECS 롤백 등) 다음 배포는 전체 재조회.
 */
async function decideStateRefresh(input: {
  deps: WorkerDeps;
  stepLog: ReturnType<typeof createStepLogger>;
  deploymentId: number;
  projectId: number;
  environmentId: number;
  moduleDirectory: string;
  variables: Record<string, TerraformVariable>;
  credentials: { accessKeyId: string; secretAccessKey: string };
  region: string;
}): Promise<boolean> {
  const { deps } = input;
  const { container_image: _image, ...infraVariables } = input.variables;
  const inputsHash = await deps.terraformCli!.fingerprint({
    moduleDirectory: input.moduleDirectory,
    region: input.region,
    credentials: input.credentials,
    variables: infraVariables,
  });
  const previous = await deps.pool.query<{
    id: number | string;
    status: string;
    terraform_inputs_hash: string;
  }>(
    `SELECT id, status, terraform_inputs_hash
     FROM deployments
     WHERE project_id = $1 AND target_environment_id = $2 AND id <> $3
       AND terraform_inputs_hash IS NOT NULL
     ORDER BY id DESC
     LIMIT 1`,
    [input.projectId, input.environmentId, input.deploymentId],
  );
  await deps.pool.query(
    "UPDATE deployments SET terraform_inputs_hash = $1, updated_at = NOW() WHERE id = $2",
    [inputsHash, input.deploymentId],
  );

  const last = previous.rows[0];
  if (last?.status === "succeeded" && last.terraform_inputs_hash === inputsHash) {
    await input.stepLog.line(
      `이미지만 바뀌어 상태 재조회 생략 — 직전 성공 배포 #${last.id} 와 인프라 입력이 같아 -refresh=false 로 plan·apply 를 한 번에 실행합니다.`,
    );
    return false;
  }
  const reason = !last
    ? "이 환경의 첫 Terraform 배포"
    : last.status !== "succeeded"
      ? `직전 배포 #${last.id} 가 성공하지 않음`
      : "인프라 입력 변경";
  await input.stepLog.line(`전체 상태 재조회로 plan → apply 를 실행합니다 (${reason}).`);
  return true;
}

async function loadProvisionContext(
  deps: WorkerDeps,
  deploymentId: number,
): Promise<ProvisionContext> {
  const result = await deps.pool.query<ProvisionContext>(
    `SELECT d.status,
            d.project_id,
            d.target_profile,
            d.target_environment_id,
            target_environment.type AS target_environment_type,
            target_environment.project_id AS target_environment_project_id,
            target_environment.aws_config,
            ir.ir_json,
            artifact.repository_uri,
            artifact.immutable_ref,
            artifact.image_digest,
            artifact.platform AS image_platform,
            d.public_url AS origin_url
     FROM deployments d
     LEFT JOIN environments target_environment
       ON target_environment.id = d.target_environment_id
     LEFT JOIN LATERAL (
       SELECT ir_json
       FROM ir_versions
       WHERE deployment_id = d.id
       ORDER BY id DESC
       LIMIT 1
     ) ir ON TRUE
     LEFT JOIN build_artifacts artifact ON artifact.deployment_id = d.id
     WHERE d.id = $1`,
    [deploymentId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("PROVISION_CONTEXT_NOT_FOUND");
  return row;
}

type OnpremAgentJobPayload = {
  jobId: string;
  attempt: number;
  deploymentId: number;
  environmentId: string;
  plan: OnpremDockerDeploymentPlan;
  image: {
    repositoryUri: string;
    digest: string;
    platform: "linux/amd64";
    registryType: "ecr";
    region: string;
  };
  environment?: Record<string, string>;
};

async function createOrGetOnpremAgentJob(
  deps: WorkerDeps,
  payload: OnpremAgentJobPayload,
): Promise<void> {
  const inserted = await deps.pool.query<{ job_id: string }>(
    `INSERT INTO onprem_agent_jobs
       (job_id, deployment_id, environment_id, attempt, status, payload)
     VALUES ($1, $2, $3, $4, 'pending', $5::jsonb)
     ON CONFLICT (deployment_id) DO NOTHING
     RETURNING job_id`,
    [
      payload.jobId,
      payload.deploymentId,
      Number(payload.environmentId),
      payload.attempt,
      JSON.stringify(payload),
    ],
  );
  if (inserted.rows[0]) return;

  const existing = await deps.pool.query<{
    job_id: string;
    status: string;
    payload: OnpremAgentJobPayload;
  }>(
    `SELECT job_id, status, payload
     FROM onprem_agent_jobs
     WHERE deployment_id = $1`,
    [payload.deploymentId],
  );
  const row = existing.rows[0];
  if (!row) throw new Error("AGENT_JOB_PERSIST_FAILED");
  if (row.payload?.image?.digest !== payload.image.digest) {
    throw new Error("AGENT_JOB_CONFLICT");
  }
  if (!["pending", "claimed", "running", "ready_for_verify"].includes(row.status)) {
    throw new Error("AGENT_JOB_NOT_RETRYABLE");
  }
}

function ecrRegionFromRepository(repositoryUri: string): string {
  const match = /^\d{12}\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\//.exec(repositoryUri);
  if (!match?.[1]) throw new Error("ECR_REPOSITORY_INVALID");
  return match[1];
}

function normalizeImagePlatform(value: string): "linux/amd64" {
  if (value !== "linux/amd64") throw new Error("IMAGE_PLATFORM_UNSUPPORTED");
  return value;
}

/**
 * 플랫폼 자동 주입 환경변수 Set — contracts 의 PLATFORM_INJECTED_ENV_NAMES 로부터 생성.
 * 우선순위: DB(user) > env_defaults > 플랫폼 자동 주입.
 */
const PLATFORM_INJECTED_ENV_VARS = new Set<string>(PLATFORM_INJECTED_ENV_NAMES);

type PlatformEnvContext = {
  containerPort: number;
  deployTarget: "aws" | "onprem";
  region: string;
};

function platformInjectedEnvValue(
  name: string,
  context: PlatformEnvContext,
): string | undefined {
  if (!PLATFORM_INJECTED_ENV_VARS.has(name)) return undefined;
  switch (name) {
    case "PORT":
      return String(context.containerPort);
    case "DEPLOY_TARGET":
      return context.deployTarget;
    case "NODE_ENV":
      return "production";
    case "AWS_REGION":
      return context.region;
  }
  return undefined;
}

async function loadProjectEnvironmentVariables(
  deps: WorkerDeps,
  projectId: number,
  names: string[],
  envDefaults: Record<string, string>,
  platformContext: PlatformEnvContext,
): Promise<Record<string, string>> {
  if (names.length === 0) return {};

  // DB 조회 — 사용자 명시 값 (가장 높은 우선순위).
  const result = await deps.pool.query<ProjectEnvironmentVariable>(
    `SELECT name, value
     FROM env_vars
     WHERE project_id = $1 AND name = ANY($2::text[])`,
    [projectId, names],
  );
  const dbVariables = Object.fromEntries(
    result.rows.map(({ name, value }) => [name, value]),
  );

  // 우선순위 적용: DB > env_defaults > 플랫폼 자동 주입.
  const merged: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    if (name in dbVariables) {
      merged[name] = dbVariables[name]!;
      continue;
    }
    const defaultValue = envDefaults[name];
    if (defaultValue !== undefined) {
      merged[name] = defaultValue;
      continue;
    }
    const platformValue = platformInjectedEnvValue(name, platformContext);
    if (platformValue !== undefined) {
      merged[name] = platformValue;
      continue;
    }
    missing.push(name);
  }

  if (missing.length > 0) {
    // 어떤 변수가 누락됐는지 명시 — AI 진단 품질 향상.
    throw new Error(`PROJECT_ENV_VAR_NOT_FOUND: ${missing.join(",")}`);
  }
  return merged;
}

/** Terraform state 위치 — 프로젝트 · 환경마다 하나. teardown 이 같은 key 로 destroy 한다 (#247) */
export function terraformStateKey(projectId: number, environmentId: number): string {
  return `projects/${projectId}/environments/${environmentId}/terraform.tfstate`;
}

/** 프로젝트 · 환경마다 고정된 AWS 리소스 이름 — teardown 도 같은 이름을 쓴다 (#247) */
export function resourceNameFor(projectId: number, environmentId: number): string {
  const scope = `${projectId}:${environmentId}`;
  return `cam-${createHash("sha256").update(scope).digest("hex").slice(0, 16)}`;
}

export function safeContainerName(name: string): string {
  const normalized = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 255);
  if (!normalized || !/^[a-zA-Z0-9_-]+$/.test(normalized)) {
    throw new Error("APP_NAME_INVALID");
  }
  return normalized;
}

function validateOriginUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TERRAFORM_OUTPUT_INVALID");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TERRAFORM_OUTPUT_INVALID");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("TERRAFORM_OUTPUT_INVALID");
  }
}

function stringOutput(outputs: TerraformOutputs, name: string): string | undefined {
  const value = outputs[name]?.value;
  return typeof value === "string" && value ? value : undefined;
}

function parsePositiveId(value: number | string | null, errorCode: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(errorCode);
  return parsed;
}

function normalizeProvisionFailure(error: unknown): string {
  if (error instanceof TerraformCliError) return error.code;
  if (error instanceof AdapterError) return error.code;
  if (error instanceof OriginActivationError) return error.code;
  if (error instanceof EcsRolloutError) return error.code;
  if (error instanceof Error) {
    const allowed = new Set([
      "PROVISION_CONTEXT_NOT_FOUND",
      "PROVISION_STATE_INVALID",
      "PROVISION_TARGET_UNSUPPORTED",
      "TERRAFORM_DEPENDENCY_MISSING",
      "TERRAFORM_MODULE_INVALID",
      "BUILD_ARTIFACT_MISSING",
      "TARGET_PROFILE_MISSING",
      "TARGET_ENVIRONMENT_REQUIRED",
      "PROJECT_ID_INVALID",
      "AWS_CREDENTIALS_UNSUPPORTED",
      "PROJECT_SECRET_NOT_FOUND",
      "PROJECT_SECRET_DECRYPT_FAILED",
      "PROJECT_ENV_VAR_NOT_FOUND",
      "APPLICATION_SECRET_DELIVERY_UNAVAILABLE",
      "APP_NAME_INVALID",
      "TERRAFORM_OUTPUT_MISSING",
      "TERRAFORM_OUTPUT_INVALID",
      "TERRAFORM_BACKEND_CONFIG_INCOMPLETE",
      "AGENT_JOB_PERSIST_FAILED",
      "AGENT_JOB_CONFLICT",
      "AGENT_JOB_NOT_RETRYABLE",
      "ECR_REPOSITORY_INVALID",
      "IMAGE_PLATFORM_UNSUPPORTED",
    ]);
    if (allowed.has(error.message)) return error.message;
  }
  return "PROVISION_FAILED";
}
