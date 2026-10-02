/**
 * apps/worker/src/handlers/teardown.ts
 *
 * 앱 삭제 (#247) — DELETE /projects/:id 가 넣은 teardown 잡.
 * 1. Agent cleanup Job 완료를 확인해 온프레미스 런타임 정리
 * 2. 공개 주소(service-{projectId}) · 온프레미스 검증 주소 DNS 와 Tunnel ingress 정리 (best effort)
 * 3. 이 앱을 배포한 AWS 연결마다 provision 과 같은 backend · 자격 증명으로 terraform destroy → state 삭제
 * 4. 배포 기록(deployments 와 딸린 row) · 프로젝트 전용 연결 · 시크릿 · 환경변수 삭제 (공용 연결은 그대로)
 * 실패하면 프로젝트를 남기고 deletion_status=failed + 이유를 기록해 다시 시도할 수 있게 한다.
 * ECR 이미지 · 업로드한 소스 ZIP 은 남긴다.
 */

import path from "node:path";
import { createDeploymentPlan } from "@camellia/adapters";
import { AwsConfigSchema } from "@camellia/contracts";
import { IrSchema } from "@camellia/ir-schema";
import type { WorkerDeps } from "../deps.js";
import { TerraformCliError, type TerraformVariable } from "../terraform-cli.js";
import { OriginActivationError } from "../origin-activation.js";
import { resourceNameFor, safeContainerName, terraformStateKey } from "./provision.js";

export type TeardownJobPayload = {
  project_id: number | string;
};

/** 끝난 배포 상태 — 나머지가 남아 있으면 정리하지 않는다 */
const FINISHED_DEPLOYMENT_STATUSES = ["succeeded", "failed", "cancelled", "rejected"];

const DEFAULT_AWS_MODULE_REF = "infra/terraform/profiles/aws-ecs-basic";
const DEFAULT_ONPREM_CLEANUP_TIMEOUT_MS = 120_000;
const DEFAULT_ONPREM_CLEANUP_POLL_INTERVAL_MS = 1_000;

/**
 * IR 을 읽을 수 없을 때 쓰는 변수. destroy 는 state 에 있는 리소스를 지우므로
 * provider region(=연결 region)만 맞으면 나머지 값은 결과에 영향이 없다 — 변수 검증만 통과하면 된다.
 */
const FALLBACK_VARIABLES = {
  app_name: "camellia-app",
  container_image: `camellia/teardown@sha256:${"0".repeat(64)}`,
  container_port: 80,
  task_cpu: 256,
  task_memory: 512,
};

type ProjectRow = {
  id: number | string;
  name: string;
  deletion_status: string | null;
  deletion_warnings: string[] | null;
};

type AwsTargetRow = {
  environment_id: number | string;
  /** 연결의 소유 프로젝트 — 공용 연결이면 null (시크릿도 공용 범위) */
  environment_project_id: number | string | null;
  target_profile: string | null;
  aws_config: unknown;
  ir_json: unknown;
  immutable_ref: string | null;
};

class TeardownError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TeardownError";
  }
}

export async function handleTeardown(
  job: { data: TeardownJobPayload },
  deps: WorkerDeps,
): Promise<void> {
  const projectId = Number(job.data.project_id);
  if (!Number.isSafeInteger(projectId) || projectId < 1) {
    deps.log?.error({ project_id: job.data.project_id }, "teardown: invalid project id");
    return;
  }

  const projectResult = await deps.pool.query<ProjectRow>(
    `SELECT id, name, deletion_status, deletion_warnings FROM projects WHERE id = $1`,
    [projectId],
  );
  const project = projectResult.rows[0];
  // 이미 지워졌거나(중복 잡) 삭제 요청 상태가 아니면 할 일이 없다
  if (!project || project.deletion_status !== "deleting") {
    deps.log?.info({ project_id: projectId }, "teardown: project not in deleting state — skipped");
    return;
  }
  const warnings = project.deletion_warnings ?? [];

  try {
    await assertNoActiveDeployment(deps, projectId);

    const onpremDeploymentIds = (
      await deps.pool.query<{ id: number | string }>(
        `SELECT DISTINCT d.id FROM deployments d
         JOIN onprem_agent_jobs job ON job.deployment_id = d.id
         WHERE d.project_id = $1
         ORDER BY d.id`,
        [projectId],
      )
    ).rows.map((row) => Number(row.id));

    // 프로젝트/배포 row를 지우면 cleanup Job도 cascade 되므로 Agent 완료 확인이 선행되어야 한다.
    await waitForOnpremCleanup(deps, onpremDeploymentIds);

    // 1. 공개 주소부터 내린다 — 지울 ALB 를 가리키는 레코드가 남지 않게
    const cloudflareFailures = await removeOrigins(deps, projectId, onpremDeploymentIds);

    // 2. AWS 리소스
    const destroyedEnvironments: string[] = [];
    const skippedEnvironments: string[] = [];
    for (const target of await loadAwsTargets(deps, projectId)) {
      const destroyed = await destroyEnvironment(deps, projectId, target);
      (destroyed ? destroyedEnvironments : skippedEnvironments).push(String(target.environment_id));
    }

    // 3. DB
    const deploymentIds = await deleteProjectRows(deps, projectId);
    await deleteStepLogs(deps, deploymentIds);

    await writeAuditLog(deps, projectId, 200, {
      result: "deleted",
      name: project.name,
      destroyedEnvironments,
      skippedEnvironments,
      cloudflareFailures,
      warnings,
    });
    deps.log?.info(
      { project_id: projectId, destroyedEnvironments, skippedEnvironments, cloudflareFailures },
      "teardown: project deleted",
    );
  } catch (error) {
    const code = normalizeTeardownFailure(error);
    const detail = error instanceof TerraformCliError && error.detail
      ? error.detail.slice(0, 2048)
      : undefined;
    deps.log?.error({ project_id: projectId, error_code: code, err: error }, "teardown failed");
    await deps.pool.query(
      `UPDATE projects SET deletion_status = 'failed', deletion_error = $2, updated_at = NOW()
       WHERE id = $1 AND deletion_status = 'deleting'`,
      [projectId, detail ? `${code}\n${detail}` : code],
    );
    await writeAuditLog(deps, projectId, 500, {
      result: "failed",
      name: project.name,
      error: code,
      warnings,
    });
  }
}

async function waitForOnpremCleanup(
  deps: WorkerDeps,
  deploymentIds: number[],
): Promise<void> {
  if (deploymentIds.length === 0) return;
  const timeoutMs = deps.onpremCleanupWait?.timeoutMs ?? DEFAULT_ONPREM_CLEANUP_TIMEOUT_MS;
  const pollIntervalMs = deps.onpremCleanupWait?.pollIntervalMs
    ?? DEFAULT_ONPREM_CLEANUP_POLL_INTERVAL_MS;
  const sleep = deps.onpremCleanupWait?.sleep
    ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const result = await deps.pool.query<{ deployment_id: number | string; status: string }>(
      `SELECT deployment_id, status
       FROM onprem_agent_cleanup_jobs
       WHERE deployment_id = ANY($1::bigint[])`,
      [deploymentIds],
    );
    const statuses = new Map(
      result.rows.map((row) => [Number(row.deployment_id), row.status]),
    );
    if (deploymentIds.every((id) => statuses.get(id) === "succeeded")) return;
    if (deploymentIds.some((id) => statuses.get(id) === "failed")) {
      throw new TeardownError("ONPREM_CLEANUP_FAILED");
    }
    if (Date.now() >= deadline) {
      throw new TeardownError("ONPREM_CLEANUP_TIMEOUT");
    }
    await sleep(Math.max(1, pollIntervalMs));
  }
}

async function assertNoActiveDeployment(deps: WorkerDeps, projectId: number): Promise<void> {
  const active = await deps.pool.query(
    `SELECT id, status FROM deployments WHERE project_id = $1 AND NOT (status = ANY($2::text[])) LIMIT 1`,
    [projectId, FINISHED_DEPLOYMENT_STATUSES],
  );
  if (active.rows.length > 0) throw new TeardownError("PROJECT_DEPLOYMENT_IN_PROGRESS");
}

async function removeOrigins(
  deps: WorkerDeps,
  projectId: number,
  onpremDeploymentIds: number[],
): Promise<string[]> {
  if (!deps.originActivator) return ["ORIGIN_CONFIGURATION_MISSING"];
  try {
    const failures = await deps.originActivator.removeProjectOrigins({ projectId, onpremDeploymentIds });
    if (failures.length > 0) {
      deps.log?.warn({ project_id: projectId, failures }, "teardown: 일부 공개 주소를 정리하지 못했습니다");
    }
    return failures;
  } catch (error) {
    const code = error instanceof OriginActivationError ? error.code : "ORIGIN_CLEANUP_FAILED";
    deps.log?.warn({ project_id: projectId, error_code: code }, "teardown: 공개 주소 정리를 건너뜁니다");
    return [code];
  }
}

/**
 * 이 앱을 배포한 AWS 연결 — 빌드 산출물이 있는 배포만 (state 는 빌드 뒤 provision 에서 생긴다).
 * 연결마다 가장 최근 배포의 IR · 이미지로 destroy 변수를 만든다.
 */
async function loadAwsTargets(deps: WorkerDeps, projectId: number): Promise<AwsTargetRow[]> {
  const result = await deps.pool.query<AwsTargetRow>(
    `SELECT DISTINCT ON (d.target_environment_id)
            d.target_environment_id AS environment_id,
            environment.project_id AS environment_project_id,
            d.target_profile,
            environment.aws_config,
            ir.ir_json,
            artifact.immutable_ref
     FROM deployments d
     JOIN environments environment
       ON environment.id = d.target_environment_id AND environment.type = 'aws'
     JOIN build_artifacts artifact ON artifact.deployment_id = d.id
     LEFT JOIN LATERAL (
       SELECT ir_json FROM ir_versions
       WHERE deployment_id = d.id
       ORDER BY id DESC LIMIT 1
     ) ir ON TRUE
     WHERE d.project_id = $1
     ORDER BY d.target_environment_id, d.id DESC`,
    [projectId],
  );
  return result.rows;
}

/** state 가 있으면 destroy 하고 state 를 지운다. state 가 없으면 false */
async function destroyEnvironment(
  deps: WorkerDeps,
  projectId: number,
  target: AwsTargetRow,
): Promise<boolean> {
  const { secretReader, terraformCli, terraformBackend, terraformModuleRoot, terraformStateStore } = deps;
  if (!secretReader || !terraformCli || !terraformBackend || !terraformModuleRoot || !terraformStateStore) {
    throw new TeardownError("TERRAFORM_DEPENDENCY_MISSING");
  }
  const environmentId = Number(target.environment_id);
  const awsConfig = AwsConfigSchema.parse(target.aws_config);
  if (
    awsConfig.credentialsType !== "access_key" ||
    !awsConfig.accessKeyIdSecretName ||
    !awsConfig.secretAccessKeySecretName
  ) {
    throw new TeardownError("AWS_CREDENTIALS_UNSUPPORTED");
  }
  // provision 과 같이 연결의 소유 범위에서 시크릿을 읽는다 (공용 연결이면 공용 시크릿)
  const ownerProjectId = target.environment_project_id === null ? null : Number(target.environment_project_id);
  const [accessKeyId, secretAccessKey] = await Promise.all([
    secretReader.read(ownerProjectId, awsConfig.accessKeyIdSecretName),
    secretReader.read(ownerProjectId, awsConfig.secretAccessKeySecretName),
  ]);
  const credentials = { accessKeyId, secretAccessKey };
  const stateKey = terraformStateKey(projectId, environmentId);
  const location = {
    bucket: terraformBackend.bucket,
    region: terraformBackend.region,
    key: stateKey,
    credentials,
  };
  if (!(await terraformStateStore.exists(location))) return false;

  const { moduleRef, variables } = destroyInputs(target);
  const moduleDirectory = path.resolve(
    terraformModuleRoot,
    moduleRef.replace(/^infra\/terraform\/profiles\//, ""),
  );
  if (!moduleDirectory.startsWith(`${path.resolve(terraformModuleRoot)}${path.sep}`)) {
    throw new TeardownError("TERRAFORM_MODULE_INVALID");
  }

  await terraformCli.destroy({
    moduleDirectory,
    backend: { ...terraformBackend, stateKey },
    region: awsConfig.region,
    credentials,
    variables: {
      ...variables,
      region: awsConfig.region,
      resource_name: resourceNameFor(projectId, environmentId),
      environment_variables: {},
      secret_references: {},
    },
  });
  await terraformStateStore.delete(location);
  return true;
}

function destroyInputs(target: AwsTargetRow): {
  moduleRef: string;
  variables: Record<string, TerraformVariable>;
} {
  try {
    const plan = createDeploymentPlan(IrSchema.parse(target.ir_json), target.target_profile ?? "");
    if (plan.target === "aws") {
      return {
        moduleRef: plan.provisioning.moduleRef,
        variables: {
          ...plan.provisioning.variables,
          app_name: safeContainerName(plan.application.name),
          container_image: target.immutable_ref ?? FALLBACK_VARIABLES.container_image,
        },
      };
    }
  } catch {
    // 옛 IR · 프로필 변경 등 — 아래 기본값으로 지운다
  }
  return { moduleRef: DEFAULT_AWS_MODULE_REF, variables: { ...FALLBACK_VARIABLES } };
}

/**
 * 배포 기록과 프로젝트를 한 트랜잭션으로 지운다. 배포를 먼저 지워야 프로젝트 전용 연결을 가리키는
 * RESTRICT FK(target/registry_environment_id, onprem_agent_jobs.environment_id)가 풀린다.
 * 프로젝트 전용 연결 · 시크릿 · 환경변수는 projects FK CASCADE 로 함께 지워지고, 공용 연결(project_id NULL)은 남는다.
 */
async function deleteProjectRows(deps: WorkerDeps, projectId: number): Promise<number[]> {
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{ deletion_status: string | null }>(
      `SELECT deletion_status FROM projects WHERE id = $1 FOR UPDATE`,
      [projectId],
    );
    if (locked.rows[0]?.deletion_status !== "deleting") throw new TeardownError("PROJECT_DELETION_CANCELLED");
    const active = await client.query(
      `SELECT id, status FROM deployments WHERE project_id = $1 AND NOT (status = ANY($2::text[])) LIMIT 1`,
      [projectId, FINISHED_DEPLOYMENT_STATUSES],
    );
    if (active.rows.length > 0) throw new TeardownError("PROJECT_DEPLOYMENT_IN_PROGRESS");
    const deployments = await client.query<{ id: number | string }>(
      `SELECT id FROM deployments WHERE project_id = $1`,
      [projectId],
    );
    await client.query(`DELETE FROM deployments WHERE project_id = $1`, [projectId]);
    await client.query(`DELETE FROM projects WHERE id = $1`, [projectId]);
    await client.query("COMMIT");
    return deployments.rows.map((row) => Number(row.id));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 배포 단계 로그 파일 (logs/deployments/{id}/) — 실패해도 삭제는 끝난 것으로 본다 */
async function deleteStepLogs(deps: WorkerDeps, deploymentIds: number[]): Promise<void> {
  for (const id of deploymentIds) {
    try {
      for (const key of await deps.storage.listKeys(`logs/deployments/${id}/`)) {
        await deps.storage.delete(key);
      }
    } catch (err) {
      deps.log?.warn({ err, deployment_id: id }, "teardown: 배포 로그 삭제 실패");
    }
  }
}

async function writeAuditLog(
  deps: WorkerDeps,
  projectId: number,
  statusCode: number,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.pool.query(
      `INSERT INTO audit_logs (actor_type, actor_id, action, resource_type, resource_id, status_code, request_id, metadata)
       VALUES ('system', NULL, 'TEARDOWN project', 'project', $1, $2, $3, $4::jsonb)`,
      [String(projectId), statusCode, `teardown-project-${projectId}`, JSON.stringify(metadata)],
    );
  } catch (err) {
    deps.log?.warn({ err, project_id: projectId }, "teardown: 감사 로그 기록 실패");
  }
}

function normalizeTeardownFailure(error: unknown): string {
  if (error instanceof TeardownError) return error.code;
  if (error instanceof TerraformCliError) return error.code;
  if (error instanceof Error) {
    const allowed = new Set([
      "PROJECT_SECRET_NOT_FOUND",
      "PROJECT_SECRET_DECRYPT_FAILED",
      "APP_NAME_INVALID",
    ]);
    if (allowed.has(error.message)) return error.message;
    const name = (error as { name?: unknown }).name;
    if (name === "ZodError") return "AWS_CONFIG_INVALID";
    if (typeof name === "string" && /^(AccessDenied|Forbidden|InvalidAccessKeyId|SignatureDoesNotMatch)/.test(name)) {
      return "TERRAFORM_STATE_ACCESS_DENIED";
    }
  }
  return "TEARDOWN_FAILED";
}
