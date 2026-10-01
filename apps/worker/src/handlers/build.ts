import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stage } from "@camellia/analyzer/stager";
import { createDeploymentPlan, AdapterError } from "@camellia/adapters";
import { AwsRegistryError } from "@camellia/aws-registry";
import { BuildError, type BuildResult } from "@camellia/build-handler";
import { AwsConfigSchema } from "@camellia/contracts";
import type { Pool } from "@camellia/db";
import { IrSchema } from "@camellia/ir-schema";
import type { WorkerDeps } from "../deps.js";
import { createStepLogger } from "../step-log.js";
import { transitionTo, type Status } from "../state-machine.js";

export type BuildJobPayload = {
  deployment_id: number;
};

type BuildContextRow = {
  status: Status;
  project_id: number | string;
  target_profile: string | null;
  source_storage_key: string | null;
  ir_json: unknown | null;
  registry_environment_type: string;
  aws_config: unknown | null;
  existing_artifact_id: number | string | null;
};

export async function handleBuild(
  job: { data: BuildJobPayload },
  deps: WorkerDeps,
): Promise<void> {
  const deploymentId = job.data.deployment_id;
  const stepLog = createStepLogger(deps, deploymentId, "build");
  let activeStatus: Status | null = null;

  try {
    const context = await loadBuildContext(deps, deploymentId);
    activeStatus = context.status;

    if (context.status === "planning" && context.existing_artifact_id !== null) {
      await autoApprovePlanAndQueueProvision(deps, deploymentId);
      return;
    }
    if (!(["queued", "building"] as Status[]).includes(context.status)) {
      throw new Error("BUILD_STATE_INVALID");
    }

    if (context.status === "queued") {
      await transitionTo(deps.pool, deploymentId, "building");
      activeStatus = "building";
      await deps.notifier?.notify(deploymentId, "state_changed", {
        status: "building",
      });
    }

    if (context.existing_artifact_id !== null) {
      await completeBuildStage(deps, deploymentId);
      return;
    }

    const required = requireBuildDependencies(deps);
    const projectId = parseProjectId(context.project_id);
    const profileId = requireString(context.target_profile, "TARGET_PROFILE_MISSING");
    const sourceStorageKey = requireString(
      context.source_storage_key,
      "SOURCE_ARTIFACT_MISSING",
    );
    const ir = IrSchema.parse(context.ir_json);
    const plan = createDeploymentPlan(ir, profileId);
    const awsConfig = AwsConfigSchema.parse(context.aws_config);

    if (
      context.registry_environment_type !== "aws" ||
      awsConfig.credentialsType !== "access_key" ||
      !awsConfig.accessKeyIdSecretName ||
      !awsConfig.secretAccessKeySecretName
    ) {
      throw new Error("AWS_REGISTRY_CREDENTIALS_INVALID");
    }

    await stepLog.line("빌드 준비");
    const [accessKeyId, secretAccessKey] = await Promise.all([
      required.secretReader.read(projectId, awsConfig.accessKeyIdSecretName),
      required.secretReader.read(projectId, awsConfig.secretAccessKeySecretName),
    ]);
    const registry = required.awsRegistryFactory({
      region: awsConfig.region,
      credentials: { accessKeyId, secretAccessKey },
    });
    const repository = await registry.ensureProjectRepository(projectId);
    const authorization = await registry.getAuthorization();
    const sourceZip = await deps.storage.get(sourceStorageKey);

    const result = await withStagedSource(sourceZip, async (workspacePath) =>
      required.registrySession.withAuthorization(
        authorization,
        async (commandEnvironment) => {
          await stepLog.line("컨테이너 이미지 빌드 및 Registry push");
          return required.buildHandler.build({
            workspacePath,
            plan: plan.build,
            image: {
              repository: repository.repositoryUri,
              tag: imageTagForDeployment(
                plan.application.version,
                deploymentId,
              ),
            },
            commandEnvironment,
          });
        },
      ),
    );

    await saveBuildArtifact(deps, deploymentId, result);
    await stepLog.line(`이미지 digest 확정: ${result.image.digest}`);
    await completeBuildStage(deps, deploymentId);
  } catch (error) {
    const errorCode = normalizeBuildFailure(error);
    deps.log?.error({ deployment_id: deploymentId, error_code: errorCode }, "build job failed");
    await stepLog.line(`빌드 실패: ${errorCode}`);

    if (activeStatus === "building" || activeStatus === "planning") {
      await transitionTo(deps.pool, deploymentId, "failed", {
        reason: errorCode,
        boss: deps.boss,
      }).catch(() => {});
      await deps.pool.query(`DELETE FROM env_locks WHERE deployment_id = $1`, [
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

async function loadBuildContext(
  deps: WorkerDeps,
  deploymentId: number,
): Promise<BuildContextRow> {
  const result = await deps.pool.query<BuildContextRow>(
    `SELECT d.status,
            d.project_id,
            d.target_profile,
            source.storage_key AS source_storage_key,
            ir.ir_json,
            registry_environment.type AS registry_environment_type,
            registry_environment.aws_config,
            artifact.id AS existing_artifact_id
     FROM deployments d
     JOIN environments registry_environment
       ON registry_environment.id = d.registry_environment_id
     LEFT JOIN LATERAL (
       SELECT storage_key
       FROM source_versions
       WHERE deployment_id = d.id
       ORDER BY id DESC
       LIMIT 1
     ) source ON TRUE
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
  if (!row) throw new Error("BUILD_CONTEXT_NOT_FOUND");
  return row;
}

function requireBuildDependencies(deps: WorkerDeps) {
  if (
    !deps.secretReader ||
    !deps.buildHandler ||
    !deps.awsRegistryFactory ||
    !deps.registrySession
  ) {
    throw new Error("BUILD_DEPENDENCY_MISSING");
  }
  return {
    secretReader: deps.secretReader,
    buildHandler: deps.buildHandler,
    awsRegistryFactory: deps.awsRegistryFactory,
    registrySession: deps.registrySession,
  };
}

async function withStagedSource<T>(
  sourceZip: Buffer,
  task: (workspacePath: string) => Promise<T>,
): Promise<T> {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "camellia-build-source-"),
  );
  const zipPath = path.join(temporaryDirectory, "source.zip");
  let staged: Awaited<ReturnType<typeof stage>> | undefined;
  try {
    await fs.writeFile(zipPath, sourceZip);
    staged = await stage(zipPath, { mode: "unzip" });
    return await task(staged.resolvedPath);
  } finally {
    await staged?.cleanup?.();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function saveBuildArtifact(
  deps: WorkerDeps,
  deploymentId: number,
  result: BuildResult,
): Promise<void> {
  await deps.pool.query(
    `INSERT INTO build_artifacts
       (deployment_id, repository_uri, image_tag, image_digest,
        immutable_ref, platform, strategy)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (deployment_id)
     DO UPDATE SET
       repository_uri = EXCLUDED.repository_uri,
       image_tag = EXCLUDED.image_tag,
       image_digest = EXCLUDED.image_digest,
       immutable_ref = EXCLUDED.immutable_ref,
       platform = EXCLUDED.platform,
       strategy = EXCLUDED.strategy,
       updated_at = NOW()`,
    [
      deploymentId,
      result.image.repository,
      result.image.tag,
      result.image.digest,
      result.image.immutableRef,
      result.platform,
      result.strategy,
    ],
  );
}

async function completeBuildStage(
  deps: WorkerDeps,
  deploymentId: number,
): Promise<void> {
  await transitionTo(deps.pool, deploymentId, "planning");
  await deps.notifier?.notify(deploymentId, "state_changed", {
    status: "planning",
  });
  await autoApprovePlanAndQueueProvision(deps, deploymentId);
}

/**
 * Plan 자동 승인:
 *   planning → awaiting_plan_approval → provisioning 를 한 트랜잭션으로 처리하고
 *   approvals 테이블에 'auto-approved' 레코드를 남긴다. COMMIT 후 provision job을 큐잉한다.
 *
 * 중간 실패 시 ROLLBACK → DB 상태는 planning 유지 → 호출자(handleBuild) catch 블록이
 * failed 전이 + env_lock 해제를 담당한다.
 */
export async function autoApprovePlanAndQueueProvision(
  deps: WorkerDeps,
  deploymentId: number,
): Promise<void> {
  await autoApprovePlanInline(deps.pool, deploymentId);
  await deps.notifier?.notify(deploymentId, "state_changed", {
    status: "awaiting_plan_approval",
  });
  await deps.notifier?.notify(deploymentId, "state_changed", {
    status: "provisioning",
  });
  await deps.boss.send("provision", { deployment_id: deploymentId });
}

export async function autoApprovePlanInline(
  pool: Pool,
  deploymentId: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const res = await client.query<{ status: string }>(
      "SELECT status FROM deployments WHERE id = $1 FOR UPDATE",
      [deploymentId],
    );
    const current = res.rows[0]?.status;
    if (current !== "planning") {
      throw new Error("AUTO_APPROVE_STATE_INVALID");
    }

    await client.query(
      `UPDATE deployments
         SET status = 'awaiting_plan_approval', updated_at = NOW()
       WHERE id = $1`,
      [deploymentId],
    );

    await client.query(
      `INSERT INTO approvals (deployment_id, gate, decision, note, decided_at)
       VALUES ($1, 'plan', 'approve', 'auto-approved: no manual plan review required', NOW())
       ON CONFLICT (deployment_id, gate) DO NOTHING`,
      [deploymentId],
    );

    await client.query(
      `UPDATE deployments
         SET status = 'provisioning', updated_at = NOW()
       WHERE id = $1`,
      [deploymentId],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function imageTagForDeployment(version: string, deploymentId: number): string {
  const normalizedVersion = version.replace(/[^A-Za-z0-9_.-]/g, "-");
  return `v${normalizedVersion}-d${deploymentId}`;
}

function parseProjectId(value: number | string): number {
  const projectId = Number(value);
  if (!Number.isSafeInteger(projectId) || projectId < 1) {
    throw new Error("PROJECT_ID_INVALID");
  }
  return projectId;
}

function requireString(value: string | null, errorCode: string): string {
  if (!value) throw new Error(errorCode);
  return value;
}

function normalizeBuildFailure(error: unknown): string {
  if (error instanceof AwsRegistryError) return error.code;
  if (error instanceof BuildError) return error.code;
  if (error instanceof AdapterError) return error.code;
  if (error instanceof Error) {
    const allowed = new Set([
      "BUILD_CONTEXT_NOT_FOUND",
      "BUILD_STATE_INVALID",
      "BUILD_DEPENDENCY_MISSING",
      "TARGET_PROFILE_MISSING",
      "SOURCE_ARTIFACT_MISSING",
      "AWS_REGISTRY_CREDENTIALS_INVALID",
      "PROJECT_SECRET_NOT_FOUND",
      "PROJECT_SECRET_DECRYPT_FAILED",
      "DOCKER_AUTH_UNAVAILABLE",
      "DOCKER_AUTH_FAILED",
      "PROJECT_ID_INVALID",
    ]);
    if (allowed.has(error.message)) return error.message;
  }
  return "BUILD_FAILED";
}
