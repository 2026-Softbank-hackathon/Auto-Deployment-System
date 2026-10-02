import { createHash } from "node:crypto";
import path from "node:path";
import {
  createDeploymentPlan,
  AdapterError,
  type AwsStaticDeploymentPlan,
  type OnpremDockerDeploymentPlan,
} from "@camellia/adapters";
import { AwsRegistryError } from "@camellia/aws-registry";
import {
  AwsConfigSchema,
  PLATFORM_INJECTED_ENV_NAMES,
  projectSubdomain,
  serviceHostname,
} from "@camellia/contracts";
import { IrSchema } from "@camellia/ir-schema";
import type { WorkerDeps } from "../deps.js";
import { createStepLogger } from "../step-log.js";
import { logMessage, type LogText } from "../log-messages.js";
import { transitionTo, type Status } from "../state-machine.js";
import { TerraformCliError, type TerraformOutputs, type TerraformVariable } from "../terraform-cli.js";
import { OriginActivationError } from "../origin-activation.js";
import { EcsRolloutError } from "../ecs-rollout.js";
import { LambdaRolloutError } from "../lambda-rollout.js";
import { StaticSitePublishError } from "../static-site-publisher.js";

export type ProvisionJobPayload = {
  deployment_id: number | string;
};

type ProvisionContext = {
  status: Status;
  project_id: number | string;
  /** 앱 주소 (#300). 비어 있으면 service-{project_id} — 정적 사이트 버킷 이름 */
  project_subdomain: string | null;
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
  /** 이미지에 넣은 Lambda Web Adapter 버전 (#280). 예전 이미지는 null */
  lambda_web_adapter: string | null;
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
      await stepLog.line(logMessage("provision.dnsPrepared"));
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
      await stepLog.line(logMessage("provision.agentJobSaved"));
      return;
    }

    if (plan.target !== "aws" || context.target_environment_type !== "aws") {
      throw new Error("PROVISION_TARGET_UNSUPPORTED");
    }
    // 배포 형태 (#282): aws-lambda-basic 이면 같은 이미지를 Lambda 로, 아니면 ECS
    const serverless = plan.runtime.type === "lambda";
    if (
      !deps.secretReader ||
      !deps.terraformCli ||
      !deps.terraformBackend ||
      !deps.terraformModuleRoot ||
      (serverless ? !deps.lambdaRolloutWaiter : !deps.ecsRolloutWaiter)
    ) {
      throw new Error("TERRAFORM_DEPENDENCY_MISSING");
    }
    if (serverless && !context.lambda_web_adapter) {
      // 재배포 빌드가 이 경우 소스로 다시 빌드하므로 보통은 오지 않는다 (#280 이전 이미지)
      throw new Error("IMAGE_LAMBDA_ADAPTER_MISSING");
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

    if (plan.runtime.type === "s3-website") {
      // 같은 state 에 이 환경의 PostgreSQL(RDS)이 있으면 정적 사이트 모듈이 DB 를 지우게 된다 — 데이터를 지키려고 멈춘다
      if (await databaseProvisionedBefore(deps, projectId, environmentId, deploymentId)) {
        await stepLog.line(logMessage("provision.staticHasDatabase"));
        throw new Error("STATIC_SITE_ENVIRONMENT_HAS_DATABASE");
      }
      await provisionStaticSite({
        deps,
        stepLog,
        context,
        deploymentId,
        projectId,
        environmentId,
        moduleDirectory,
        stateKey,
        resourceName,
        plan: plan as AwsStaticDeploymentPlan,
        region: awsConfig.region,
        credentials: { accessKeyId, secretAccessKey },
        onStatus: (status) => {
          activeStatus = status;
        },
      });
      return;
    }

    // PostgreSQL 추가 모듈 (#278). 이번 IR 에 DB 가 없어도 이 환경에 만든 DB 는 앱 삭제 전까지 지우지 않는다
    // (수정안을 거절한 새 버전 등으로 DB 와 데이터가 같이 사라지는 것을 막는다).
    let databaseEnabled = plan.provisioning.variables["database_enabled"] === true;
    if (databaseEnabled) {
      await stepLog.line(logMessage("provision.databaseCreate"));
    } else if (await databaseProvisionedBefore(deps, projectId, environmentId, deploymentId)) {
      if (serverless) {
        // 서버리스 프로필은 같은 state 에 DB 모듈이 없어 apply 하면 RDS 와 데이터가 지워진다
        await stepLog.line(logMessage("provision.serverlessHasDatabase"));
        throw new Error("SERVERLESS_DATABASE_PRESENT");
      }
      databaseEnabled = true;
      await stepLog.line(logMessage("provision.databaseKeep"));
    }
    const terraformVariables = {
      ...plan.provisioning.variables,
      ...(serverless ? {} : { database_enabled: databaseEnabled }),
      app_name: safeContainerName(plan.application.name),
      region: awsConfig.region,
      resource_name: resourceName,
      container_image: context.immutable_ref,
      environment_variables: environmentVariables,
      secret_references: {},
    };
    const terraformRequest = {
      moduleDirectory,
      backend: {
        ...deps.terraformBackend,
        stateKey,
      },
      region: awsConfig.region,
      credentials: { accessKeyId, secretAccessKey },
      variables: terraformVariables,
      log: (line: LogText) => stepLog.line(line),
    };
    const applied = context.status === "deploying" && context.origin_url
      ? {
          originUrl: context.origin_url,
          outputs: await deps.terraformCli.output(terraformRequest),
        }
      : await applyTerraform({
          deps,
          stepLog,
          deploymentId,
          projectId,
          environmentId,
          moduleDirectory,
          stateKey,
          resourceName,
          variables: terraformVariables,
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

    if (serverless) {
      // Terraform 이 이미지 갱신 · 버전 발행 · alias 이동까지 한다. alias 가 이번 digest 로 Active 가 될 때까지 확인한다 (#282).
      await deps.lambdaRolloutWaiter!.wait({
        region: awsConfig.region,
        credentials: { accessKeyId, secretAccessKey },
        functionName: stringOutput(applied.outputs, "function_name") ?? resourceName,
        alias: stringOutput(applied.outputs, "function_alias") ?? "live",
        expectedDigest: context.image_digest,
        log: (line) => stepLog.line(line),
      });
    } else {
      const expectedTaskDefinition = stringOutput(applied.outputs, "task_definition_arn");
      if (!expectedTaskDefinition) throw new Error("TERRAFORM_OUTPUT_MISSING");

      // Terraform 은 서비스 갱신만 하고 돌아온다 (wait_for_steady_state = false, #253).
      // 롤아웃 완료를 여기서 기다린 뒤 최종 검증으로 넘긴다. 재시도로 apply 를 건너뛴 경우에도 다시 확인한다.
      await deps.ecsRolloutWaiter!.wait({
        region: awsConfig.region,
        credentials: { accessKeyId, secretAccessKey },
        clusterName: stringOutput(applied.outputs, "cluster_name") ?? resourceName,
        serviceName: stringOutput(applied.outputs, "service_name") ?? resourceName,
        expectedTaskDefinition,
        log: (line) => stepLog.line(line),
      });
    }

    await transitionTo(deps.pool, deploymentId, "verifying");
    activeStatus = "verifying";
    await deps.notifier?.notify(deploymentId, "state_changed", {
      status: "verifying",
    });
    await stepLog.line(logMessage(serverless ? "provision.lambdaDone" : "provision.ecsDone"));
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
      (error instanceof TerraformCliError ||
        error instanceof EcsRolloutError ||
        error instanceof LambdaRolloutError ||
        error instanceof StaticSitePublishError) && error.detail
        ? error.detail.slice(0, 2048)
        : undefined;
    deps.log?.error(
      { deployment_id: deploymentId, error_code: errorCode },
      "provision job failed",
    );
    await stepLog.line(logMessage("provision.failed", { code: errorCode }));
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

/**
 * 정적 사이트 on AWS (#274) — 서버 없이 S3 웹사이트 호스팅.
 * 1. Terraform 으로 버킷(이름 = 공개 호스트 이름) · 웹사이트 설정 · 버킷 정책.
 *    인프라 입력이 직전 성공 배포와 같으면 Terraform 을 건너뛰고 그 배포의 출력값을 쓴다 (#299)
 * 2. 빌드한 이미지(같은 digest)에서 파일을 꺼내 버킷과 맞춘다
 * 3. S3 웹사이트 endpoint 를 직접 검증한 뒤 verify 가 Cloudflare 공개 주소를 그쪽으로 바꾼다
 */
async function provisionStaticSite(input: {
  deps: WorkerDeps;
  stepLog: ReturnType<typeof createStepLogger>;
  context: ProvisionContext;
  deploymentId: number;
  projectId: number;
  environmentId: number;
  moduleDirectory: string;
  stateKey: string;
  resourceName: string;
  plan: AwsStaticDeploymentPlan;
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  onStatus: (status: Status) => void;
}): Promise<void> {
  const { deps, stepLog, context, deploymentId, plan, credentials, region } = input;
  if (!deps.staticSitePublisher || !deps.awsRegistryFactory || !deps.registrySession) {
    throw new Error("STATIC_SITE_DEPENDENCY_MISSING");
  }
  if (!deps.platformDomain) throw new Error("STATIC_SITE_DOMAIN_MISSING");
  const bucket = staticSiteBucketName(input.projectId, deps.platformDomain, context.project_subdomain);

  // 버킷 정책은 Cloudflare 에서 오는 요청만 받는다 — 공개 주소를 바꾸기 전 직접 검증하려고 워커 IP 도 연다
  const egressIp = await deps.egressIpResolver?.();
  if (!egressIp) {
    await stepLog.line(logMessage("provision.egressIpUnknown"));
  }
  const variables: Record<string, TerraformVariable> = {
    ...plan.provisioning.variables,
    app_name: safeContainerName(plan.application.name),
    region,
    bucket_name: bucket,
    verifier_cidrs: egressIp ? [`${egressIp}/32`] : [],
  };

  await stepLog.line(logMessage("provision.staticSite", { bucket }));
  let applied: { originUrl: string; outputs: TerraformOutputs };
  if (context.status === "deploying" && context.origin_url) {
    applied = {
      originUrl: context.origin_url,
      outputs: await deps.terraformCli!.output({
        moduleDirectory: input.moduleDirectory,
        backend: { ...deps.terraformBackend!, stateKey: input.stateKey },
        region,
        credentials,
        variables,
        log: (line: LogText) => stepLog.line(line),
      }),
    };
  } else {
    const terraformInput = {
      deps,
      stepLog,
      deploymentId,
      projectId: input.projectId,
      environmentId: input.environmentId,
      moduleDirectory: input.moduleDirectory,
      stateKey: input.stateKey,
      resourceName: input.resourceName,
      variables,
      credentials,
      region,
    };
    const history = await recordTerraformInputs(terraformInput);
    const reused = reusableStaticOutputs(history);
    if (reused) {
      await stepLog.line(logMessage("provision.staticReuse", { deployment: String(history.last!.id) }));
      applied = reused;
    } else {
      applied = await applyTerraform({ ...terraformInput, history });
    }
  }
  const originUrl = applied.originUrl;
  validateOriginUrl(originUrl);
  // 출력값을 남겨 두면 인프라 입력이 같은 다음 갱신이 Terraform 을 건너뛴다 (#299)
  await deps.pool.query(
    `UPDATE deployments
     SET public_url = $1, terraform_outputs = $2::jsonb, updated_at = NOW()
     WHERE id = $3`,
    [originUrl, JSON.stringify(storableOutputs(applied.outputs)), deploymentId],
  );
  if (context.status === "provisioning") {
    await transitionTo(deps.pool, deploymentId, "deploying");
    input.onStatus("deploying");
    await deps.notifier?.notify(deploymentId, "state_changed", { status: "deploying" });
  }

  // 같은 이미지에서 파일을 꺼낸다 — ECR 로그인은 build 와 같은 방식
  const registry = deps.awsRegistryFactory({
    region: ecrRegionFromRepository(context.repository_uri!),
    credentials,
  });
  const authorization = await registry.getAuthorization();
  await stepLog.line(logMessage("provision.staticExtract", { digest: context.image_digest ?? "" }));
  await deps.registrySession.withAuthorization(authorization, (commandEnvironment) =>
    deps.staticSitePublisher!.publish({
      imageRef: context.immutable_ref!,
      platform: normalizeImagePlatform(context.image_platform!),
      commandEnvironment,
      bucket: stringOutput(applied.outputs, "bucket_name") ?? bucket,
      region,
      credentials,
      log: (line) => stepLog.line(line),
    }),
  );

  await transitionTo(deps.pool, deploymentId, "verifying");
  input.onStatus("verifying");
  await deps.notifier?.notify(deploymentId, "state_changed", { status: "verifying" });
  await stepLog.line(logMessage("provision.staticSynced"));
  await deps.boss.send("verify", {
    jobId: `verify-deployment-${deploymentId}`,
    attempt: 1,
    deploymentId,
    environmentId: String(input.environmentId),
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
}

/**
 * 정적 사이트 버킷 이름 = 공개 호스트 이름 (#274). S3 웹사이트 endpoint 는 Host 헤더로 버킷을 찾으므로
 * Cloudflare 가 {subdomain}.{도메인} 으로 프록시하려면 버킷 이름이 정확히 같아야 한다.
 * 앱 주소(#300)를 고르지 않은 예전 프로젝트는 service-{projectId}.
 */
export function staticSiteBucketName(
  projectId: number,
  platformDomain: string,
  subdomain?: string | null,
): string {
  return serviceHostname(projectSubdomain(subdomain, projectId).toLowerCase(), platformDomain);
}

/**
 * 인프라 변경 없는 정적 사이트 갱신 (#299) — 같은 프로젝트 · 환경의 직전 Terraform 배포가 성공했고
 * 입력 지문(모듈 파일 · 버킷 이름 · 워커 IP · region · 키 등)이 같고 그 배포가 정적 사이트 출력값을 남겼으면
 * Terraform 을 돌리지 않고 그 출력값을 쓴다. 버킷 · 정책을 바꿀 입력이 없으므로 apply 결과도 같다.
 * 첫 배포 · 입력 변경 · 직전 실패 · 출력값 없음이면 null → 지금처럼 Terraform 실행.
 */
function reusableStaticOutputs(
  history: TerraformInputsHistory,
): { originUrl: string; outputs: TerraformOutputs } | null {
  const last = history.last;
  if (
    !last ||
    last.status !== "succeeded" ||
    last.terraform_inputs_hash !== history.inputsHash ||
    last.target_profile !== "aws-static-basic"
  ) {
    return null;
  }
  const outputs = last.terraform_outputs;
  if (!outputs || typeof outputs !== "object" || Array.isArray(outputs)) return null;
  const originUrl = outputs["origin_url"]?.value;
  if (typeof originUrl !== "string" || !originUrl) return null;
  return { originUrl, outputs };
}

/** DB 에 남길 출력값 — sensitive 출력은 뺀다 */
function storableOutputs(outputs: TerraformOutputs): TerraformOutputs {
  return Object.fromEntries(
    Object.entries(outputs).filter(([, output]) => output.sensitive !== true),
  );
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
  variables: Record<string, TerraformVariable>;
  credentials: { accessKeyId: string; secretAccessKey: string };
  region: string;
  /** 호출자가 이미 기록 · 조회한 입력 지문 (정적 사이트, #299). 없으면 여기서 한다 */
  history?: TerraformInputsHistory;
}): Promise<{ originUrl: string; outputs: TerraformOutputs }> {
  const { deps } = input;
  const refresh = await decideStateRefresh(
    input.stepLog,
    input.history ?? (await recordTerraformInputs(input)),
  );
  await input.stepLog.line(logMessage("provision.terraformStart"));
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
    await input.stepLog.line(logMessage("provision.terraformApplied"));
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

type TerraformInputsHistory = {
  /** 이번 배포의 인프라 입력 지문 */
  inputsHash: string;
  /** 같은 프로젝트 · 환경에서 직전에 지문을 남긴 배포 */
  last:
    | {
        id: number | string;
        status: string;
        terraform_inputs_hash: string;
        target_profile: string | null;
        terraform_outputs: TerraformOutputs | null;
      }
    | undefined;
};

/**
 * 이번 배포의 인프라 입력 지문을 기록하고, 같은 프로젝트 · 환경에서 직전에 Terraform 을 돌린 배포를 찾는다.
 * 지문은 이미지와 앱 이름을 뺀 Terraform 입력(모듈 파일 · 변수 · region · access key ID)이다.
 * 앱 이름은 분석기가 이름을 못 찾으면 업로드 폴더 이름(camellia-stage-<소스 해시>)이라 배포마다 바뀐다 (#299).
 * 지문은 apply 전에 이번 배포에 기록한다 → apply 나 검증이 실패하면(ECS 롤백 등) 다음 배포는 전체 재조회.
 */
async function recordTerraformInputs(input: {
  deps: WorkerDeps;
  deploymentId: number;
  projectId: number;
  environmentId: number;
  moduleDirectory: string;
  variables: Record<string, TerraformVariable>;
  credentials: { accessKeyId: string; secretAccessKey: string };
  region: string;
}): Promise<TerraformInputsHistory> {
  const { deps } = input;
  const { container_image: _image, app_name: _appName, ...infraVariables } = input.variables;
  const inputsHash = await deps.terraformCli!.fingerprint({
    moduleDirectory: input.moduleDirectory,
    region: input.region,
    credentials: input.credentials,
    variables: infraVariables,
  });
  const previous = await deps.pool.query<NonNullable<TerraformInputsHistory["last"]>>(
    `SELECT id, status, terraform_inputs_hash, target_profile, terraform_outputs
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
  return { inputsHash, last: previous.rows[0] };
}

/**
 * 이미지만 바뀐 재배포의 상태 재조회 생략 (#252, 팀 합의 2026-10-02).
 * 인프라 입력 지문이 직전에 Terraform 을 돌린 배포와 같고 그 배포가 성공했을 때만 -refresh=false 로 하고,
 * 이때는 plan · apply 를 apply 한 번으로 합친다 (#260).
 */
async function decideStateRefresh(
  stepLog: ReturnType<typeof createStepLogger>,
  { inputsHash, last }: TerraformInputsHistory,
): Promise<boolean> {
  if (last?.status === "succeeded" && last.terraform_inputs_hash === inputsHash) {
    await stepLog.line(logMessage("provision.refreshSkipped", { deployment: String(last.id) }));
    return false;
  }
  await stepLog.line(
    !last
      ? logMessage("provision.refreshFirst")
      : last.status !== "succeeded"
        ? logMessage("provision.refreshLastFailed", { deployment: String(last.id) })
        : logMessage("provision.refreshInputsChanged"),
  );
  return true;
}

/** 같은 프로젝트 · 환경에서 postgres 리소스가 있는 IR 로 Terraform 을 실행한 적이 있는지 */
async function databaseProvisionedBefore(
  deps: WorkerDeps,
  projectId: number,
  environmentId: number,
  deploymentId: number,
): Promise<boolean> {
  const result = await deps.pool.query<{ id: number | string }>(
    `SELECT d.id
     FROM deployments d
     JOIN LATERAL (
       SELECT ir_json FROM ir_versions
       WHERE deployment_id = d.id
       ORDER BY id DESC LIMIT 1
     ) ir ON TRUE
     WHERE d.project_id = $1 AND d.target_environment_id = $2 AND d.id <> $3
       AND d.terraform_inputs_hash IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM jsonb_each(COALESCE(ir.ir_json -> 'resources', '{}'::jsonb)) resource
         WHERE resource.value ->> 'type' = 'postgres'
       )
     LIMIT 1`,
    [projectId, environmentId, deploymentId],
  );
  return result.rows.length > 0;
}

async function loadProvisionContext(
  deps: WorkerDeps,
  deploymentId: number,
): Promise<ProvisionContext> {
  const result = await deps.pool.query<ProvisionContext>(
    `SELECT d.status,
            d.project_id,
            (SELECT p.subdomain FROM projects p WHERE p.id = d.project_id) AS project_subdomain,
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
            artifact.lambda_web_adapter,
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
  if (error instanceof LambdaRolloutError) return error.code;
  if (error instanceof StaticSitePublishError) return error.code;
  if (error instanceof AwsRegistryError) return error.code;
  if (error instanceof Error) {
    const allowed = new Set([
      "STATIC_SITE_DEPENDENCY_MISSING",
      "STATIC_SITE_DOMAIN_MISSING",
      "STATIC_SITE_ENVIRONMENT_HAS_DATABASE",
      "DOCKER_AUTH_UNAVAILABLE",
      "DOCKER_AUTH_FAILED",
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
      "IMAGE_LAMBDA_ADAPTER_MISSING",
      "SERVERLESS_DATABASE_PRESENT",
    ]);
    if (allowed.has(error.message)) return error.message;
  }
  return "PROVISION_FAILED";
}
