import { createHash } from "node:crypto";
import path from "node:path";
import { createDeploymentPlan, AdapterError } from "@camellia/adapters";
import { AwsConfigSchema } from "@camellia/contracts";
import { IrSchema } from "@camellia/ir-schema";
import type { WorkerDeps } from "../deps.js";
import { createStepLogger } from "../step-log.js";
import { transitionTo, type Status } from "../state-machine.js";
import { TerraformCliError } from "../terraform-cli.js";

export type ProvisionJobPayload = {
  deployment_id: number;
};

type ProvisionContext = {
  status: Status;
  project_id: number | string;
  target_profile: string | null;
  target_environment_id: number | string | null;
  target_environment_type: string | null;
  aws_config: unknown;
  ir_json: unknown;
  immutable_ref: string | null;
  image_digest: string | null;
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
  const deploymentId = job.data.deployment_id;
  const stepLog = createStepLogger(deps, deploymentId, "provision");
  let activeStatus: Status | null = null;

  try {
    const context = await loadProvisionContext(deps, deploymentId);
    activeStatus = context.status;

    if (context.status === "verifying") return;
    if (context.status !== "provisioning" && context.status !== "deploying") {
      throw new Error("PROVISION_STATE_INVALID");
    }

    const projectId = parsePositiveId(context.project_id, "PROJECT_ID_INVALID");
    const environmentId = parsePositiveId(
      context.target_environment_id,
      "TARGET_ENVIRONMENT_REQUIRED",
    );
    if (context.target_environment_type !== "aws") {
      throw new Error("PROVISION_TARGET_UNSUPPORTED");
    }
    if (!context.target_profile) throw new Error("TARGET_PROFILE_MISSING");
    if (!deps.secretReader || !deps.terraformCli || !deps.terraformBackend || !deps.terraformModuleRoot) {
      throw new Error("TERRAFORM_DEPENDENCY_MISSING");
    }
    if (!context.immutable_ref || !context.image_digest) {
      throw new Error("BUILD_ARTIFACT_MISSING");
    }

    const awsConfig = AwsConfigSchema.parse(context.aws_config);
    if (
      awsConfig.credentialsType !== "access_key" ||
      !awsConfig.accessKeyIdSecretName ||
      !awsConfig.secretAccessKeySecretName
    ) {
      throw new Error("AWS_CREDENTIALS_UNSUPPORTED");
    }
    const [accessKeyId, secretAccessKey] = await Promise.all([
      deps.secretReader.read(projectId, awsConfig.accessKeyIdSecretName),
      deps.secretReader.read(projectId, awsConfig.secretAccessKeySecretName),
    ]);

    const ir = IrSchema.parse(context.ir_json);
    const plan = createDeploymentPlan(ir, context.target_profile);
    if (plan.target !== "aws") throw new Error("PROVISION_TARGET_UNSUPPORTED");
    if (plan.service.secretNames.length > 0) {
      throw new Error("APPLICATION_SECRET_DELIVERY_UNAVAILABLE");
    }

    const environmentVariables = await loadProjectEnvironmentVariables(
      deps,
      projectId,
      plan.service.environmentNames,
    );
    const moduleDirectory = path.resolve(
      deps.terraformModuleRoot,
      plan.provisioning.moduleRef.replace(/^infra\/terraform\/profiles\//, ""),
    );
    if (!moduleDirectory.startsWith(`${path.resolve(deps.terraformModuleRoot)}${path.sep}`)) {
      throw new Error("TERRAFORM_MODULE_INVALID");
    }

    const stateKey = `projects/${projectId}/environments/${environmentId}/terraform.tfstate`;
    const resourceName = resourceNameFor(projectId, environmentId);
    const originUrl = context.status === "deploying" && context.origin_url
      ? context.origin_url
      : await applyTerraform({
          deps,
          stepLog,
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

    validateOriginUrl(originUrl);
    await deps.pool.query(
      "UPDATE deployments SET public_url = $1, updated_at = NOW() WHERE id = $2",
      [originUrl, deploymentId],
    );

    if (context.status === "provisioning") {
      await transitionTo(deps.pool, deploymentId, "deploying");
      await deps.notifier?.notify(deploymentId, "state_changed", {
        status: "deploying",
      });
    }

    await transitionTo(deps.pool, deploymentId, "verifying");
    await deps.notifier?.notify(deploymentId, "state_changed", {
      status: "verifying",
    });
    await stepLog.line("인프라 적용 완료, 롤아웃 및 헬스체크 검증을 시작합니다.");
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
    deps.log?.error(
      { deployment_id: deploymentId, error_code: errorCode },
      "provision job failed",
    );
    await stepLog.line(`프로비저닝 실패: ${errorCode}`);

    if (
      activeStatus === "provisioning" ||
      activeStatus === "deploying" ||
      activeStatus === "verifying"
    ) {
      await transitionTo(deps.pool, deploymentId, "failed", {
        reason: errorCode,
        boss: deps.boss,
      }).catch(() => {});
      await deps.pool.query("DELETE FROM env_locks WHERE deployment_id = $1", [
        deploymentId,
      ]);
      await deps.notifier?.notify(deploymentId, "state_changed", {
        status: "failed",
      });
      return;
    }
    throw error;
  }
}

async function applyTerraform(input: {
  deps: WorkerDeps;
  stepLog: ReturnType<typeof createStepLogger>;
  moduleDirectory: string;
  stateKey: string;
  resourceName: string;
  variables: Record<string, string | number | boolean | Record<string, string>>;
  credentials: { accessKeyId: string; secretAccessKey: string };
  region: string;
}): Promise<string> {
  const { deps } = input;
  await input.stepLog.line("Terraform init · validate · plan · apply 시작");
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
    });
    const originUrl = outputs["origin_url"]?.value;
    if (typeof originUrl !== "string") {
      throw new Error("TERRAFORM_OUTPUT_MISSING");
    }
    await input.stepLog.line("Terraform apply 완료, origin endpoint를 수집했습니다.");
    return originUrl;
  } catch (error) {
    if (error instanceof TerraformCliError) throw error;
    if (error instanceof AdapterError) throw error;
    if (error instanceof Error && error.message === "TERRAFORM_OUTPUT_MISSING") {
      throw error;
    }
    throw new Error("TERRAFORM_APPLY_FAILED");
  }
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
            target_environment.aws_config,
            ir.ir_json,
            artifact.immutable_ref,
            artifact.image_digest,
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

async function loadProjectEnvironmentVariables(
  deps: WorkerDeps,
  projectId: number,
  names: string[],
): Promise<Record<string, string>> {
  if (names.length === 0) return {};
  const result = await deps.pool.query<ProjectEnvironmentVariable>(
    `SELECT name, value
     FROM env_vars
     WHERE project_id = $1 AND name = ANY($2::text[])`,
    [projectId, names],
  );
  const variables = Object.fromEntries(
    result.rows.map(({ name, value }) => [name, value]),
  );
  if (names.some((name) => !(name in variables))) {
    throw new Error("PROJECT_ENV_VAR_NOT_FOUND");
  }
  return variables;
}

function resourceNameFor(projectId: number, environmentId: number): string {
  const scope = `${projectId}:${environmentId}`;
  return `cam-${createHash("sha256").update(scope).digest("hex").slice(0, 16)}`;
}

function safeContainerName(name: string): string {
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

function parsePositiveId(value: number | string | null, errorCode: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(errorCode);
  return parsed;
}

function normalizeProvisionFailure(error: unknown): string {
  if (error instanceof TerraformCliError) return error.code;
  if (error instanceof AdapterError) return error.code;
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
    ]);
    if (allowed.has(error.message)) return error.message;
  }
  return "PROVISION_FAILED";
}
