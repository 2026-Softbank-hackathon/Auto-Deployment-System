import { createHash } from "node:crypto";
import { enqueueOnpremCleanup, type Pool } from "@camellia/db";
import type { WorkerDeps } from "./deps.js";
import { transitionTo } from "./state-machine.js";
import type { OriginActivationReceipt } from "./origin-activation.js";
import { formatLogText, logMessage, renderLogText } from "./log-messages.js";
import {
  buildHealthUrl,
  handleVerify,
  type HealthCheckAttempt,
  type VerifyJobPayload,
  type VerifyResult,
  type VerifyRuntime,
  REQUIRED_PASSES,
  VerifyJobPayloadSchema,
  VerifyResultSchema,
} from "./handlers/verify.js";

type VerifyStepClaim =
  | { owned: true; stepId: number }
  | {
      owned: false;
      stepId: number;
      result: VerifyResult;
      phase: VerificationPhase;
      completed: boolean;
      activation?: OriginActivationReceipt;
    };

export type VerificationAttemptPhase = "target" | "public_url";
export type VerificationPhase =
  | VerificationAttemptPhase
  | "origin_switching";

type ExistingVerifyStep = {
  id: string | number;
  deployment_id: string | number;
  status: "running" | "succeeded" | "failed";
  message: string | null;
};

export class VerifyJobInProgressError extends Error {
  constructor(jobId: string) {
    super(`verify job ${jobId} is already running`);
    this.name = "VerifyJobInProgressError";
  }
}

export class VerifyJobConflictError extends Error {
  constructor(jobId: string) {
    super(`verify job ${jobId} payload conflicts with the stored execution`);
    this.name = "VerifyJobConflictError";
  }
}

export const ONPREM_ROLLBACK_GRACE_MS = 15 * 60 * 1000;

export async function runVerifyJob(
  job: { data: VerifyJobPayload },
  deps: WorkerDeps,
  runtime: Pick<VerifyRuntime, "sleep" | "signal"> = {
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  },
): Promise<VerifyResult> {
  const validated = VerifyJobPayloadSchema.safeParse(job.data);
  if (!validated.success) return handleVerify(job, deps, runtime);

  const validJob = { data: validated.data };
  const claim = await claimVerifyStep(deps.pool, validJob.data);
  if (!claim.owned && claim.completed) {
    await resumeCompletedVerify(deps, validJob.data.deploymentId, claim);
    return claim.result;
  }
  const stepId = claim.stepId;

  let targetResult: VerifyResult;
  if (claim.owned) {
    try {
      targetResult = await handleVerify(validJob, deps, {
        ...runtime,
        onAttempt: (attempt) =>
          persistHealthCheckAttempt(
            deps.pool,
            stepId,
            validJob.data.environmentId,
            attempt,
            "target",
        ),
      });
    } catch (error) {
      await finishVerifyStep(
        deps.pool,
        stepId,
        internalFailureResult(
          validJob.data,
          resolveHealthTargetUrl(validJob.data) ?? "",
        ),
        validJob.data,
        { phase: "target" },
      );
      await finalizeDeploymentState(
        deps,
        validJob.data.deploymentId,
        "failed",
        "verify_internal_error",
      );
      throw error;
    }
    if (targetResult.status === "failed") {
      await finishVerifyStep(
        deps.pool,
        stepId,
        targetResult,
        validJob.data,
        { phase: "target" },
      );
      await finalizeDeploymentState(
        deps,
        validJob.data.deploymentId,
        "failed",
        targetResult.failureReason,
      );
      return targetResult;
    }
    await recordTargetVerifyPassed(
      deps.pool,
      stepId,
      targetResult,
      validJob.data,
    );
  } else {
    targetResult = claim.result;
  }

  const originActivator = deps.originActivator;
  const finalUrlVerifier = deps.finalUrlVerifier;
  if (!originActivator || !finalUrlVerifier) {
    throw new Error("VERIFY_ROLLOUT_DEPENDENCY_MISSING");
  }

  const activation = !claim.owned && claim.activation
    ? claim.activation
    : await originActivator.activate(validJob.data);
  if (!activation) return targetResult;
  if (activation.reused) {
    // 공개 주소 레코드가 이미 이번 origin 이라 DNS 갱신 · 권한 DNS 대기 없이 공개 주소 검증으로 간다 (#299)
    const line = logMessage("verify.originReused");
    deps.log?.info(
      { deployment_id: validJob.data.deploymentId, origin: activation.activatedOrigin },
      renderLogText(line),
    );
    try {
      await deps.notifier?.notify(validJob.data.deploymentId, "log.line", {
        step: "verify",
        line: `[${new Date().toISOString()}] ${formatLogText(line)}`,
      });
    } catch {
      // 진행 로그 발행 실패는 검증을 멈추지 않는다
    }
  }

  await recordPublicUrlPhase(
    deps.pool,
    stepId,
    targetResult,
    validJob.data,
    activation,
  );

  let publicResult: VerifyResult;
  try {
    publicResult = await finalUrlVerifier.verify(
      {
        deploymentId: validJob.data.deploymentId,
        environmentId: validJob.data.environmentId,
        serviceHostname: activation.serviceHostname,
        health: validJob.data.health,
        ...(activation.reused ? { originUnchanged: true } : {}),
      },
      {
        ...runtime,
        onAttempt: (attempt) =>
          persistHealthCheckAttempt(
            deps.pool,
            stepId,
            validJob.data.environmentId,
            attempt,
            "public_url",
          ),
      },
    );
  } catch (error) {
    const internalResult = internalFailureResult(
      validJob.data,
      buildHealthUrl(
        `https://${activation.serviceHostname}`,
        validJob.data.health.path,
      ),
    );
    await finishVerifyStep(
      deps.pool,
      stepId,
      internalResult,
      validJob.data,
      { phase: "public_url", targetResult, activation },
    );
    const restored = await rollbackOrigin(
      deps,
      validJob.data.deploymentId,
      activation,
      internalResult.failureReason,
    );
    if (!restored) throw new Error("ORIGIN_ROLLBACK_FAILED", { cause: error });
    throw error;
  }

  await finishVerifyStep(
    deps.pool,
    stepId,
    publicResult,
    validJob.data,
    { phase: "public_url", targetResult, activation },
  );
  if (publicResult.status === "failed") {
    const restored = await rollbackOrigin(
      deps,
      validJob.data.deploymentId,
      activation,
      publicResult.failureReason,
    );
    if (!restored) throw new Error("ORIGIN_ROLLBACK_FAILED");
    return publicResult;
  }
  await finalizeDeploymentState(
    deps,
    validJob.data.deploymentId,
    "succeeded",
  );
  return publicResult;
}

async function resumeCompletedVerify(
  deps: WorkerDeps,
  deploymentId: number,
  claim: Extract<VerifyStepClaim, { owned: false }>,
): Promise<void> {
  const current = await deps.pool.query<{ status: string }>(
    "SELECT status FROM deployments WHERE id = $1",
    [deploymentId],
  );
  const status = current.rows[0]?.status;
  if (status === "verifying" && claim.result.status === "passed") {
    await finalizeDeploymentState(deps, deploymentId, "succeeded");
    return;
  }
  if (
    claim.result.status === "failed" &&
    claim.phase === "public_url" &&
    claim.activation &&
    (status === "verifying" || status === "rollback" || status === "failed")
  ) {
    const restored = await rollbackOrigin(
      deps,
      deploymentId,
      claim.activation,
      claim.result.failureReason,
    );
    if (!restored) throw new Error("ORIGIN_ROLLBACK_FAILED");
    return;
  }
  if (status === "verifying" && claim.result.status === "failed") {
    await finalizeDeploymentState(
      deps,
      deploymentId,
      "failed",
      claim.result.failureReason,
    );
  }
}

/**
 * verify 결과를 deployment 레벨로 반영.
 *   - verifying → succeeded / failed 전이 (state-machine 유효 전이)
 *   - env_locks 삭제 (해당 환경 재배포 unblock)
 *   - SSE state_changed 알림
 * 상태 전이·lock/SSE는 기존처럼 best-effort다. 단, 런타임 cleanup 예약 실패는
 * worker 재시도로 복구할 수 있도록 마지막에 다시 던진다.
 */
export async function finalizeDeploymentState(
  deps: WorkerDeps,
  deploymentId: number,
  nextStatus: "succeeded" | "failed",
  reason?: string,
): Promise<void> {
  let cleanupSchedulingError: unknown;
  try {
    if (nextStatus === "succeeded") {
      await activateVerifiedDeployment(deps.pool, deploymentId);
    } else {
      await transitionTo(deps.pool, deploymentId, nextStatus, {
        reason,
        boss: deps.boss,
      });
    }
  } catch (err) {
    deps.log?.warn(
      { deployment_id: deploymentId, next: nextStatus, err },
      "verify finalize: transitionTo skipped (likely terminal state already)",
    );
  }
  try {
    await scheduleOnpremRuntimeCleanup(deps, deploymentId, nextStatus);
  } catch (err) {
    cleanupSchedulingError = err;
    deps.log?.warn(
      { deployment_id: deploymentId, next: nextStatus, err },
      "verify finalize: on-prem cleanup scheduling failed",
    );
  }
  try {
    await deps.pool.query(
      "DELETE FROM env_locks WHERE deployment_id = $1",
      [deploymentId],
    );
  } catch (err) {
    deps.log?.warn(
      { deployment_id: deploymentId, err },
      "verify finalize: env_lock cleanup failed",
    );
  }
  try {
    await deps.notifier?.notify(deploymentId, "state_changed", {
      status: nextStatus,
    });
  } catch (err) {
    deps.log?.warn(
      { deployment_id: deploymentId, next: nextStatus, err },
      "verify finalize: SSE notify failed",
    );
  }
  if (cleanupSchedulingError) throw cleanupSchedulingError;
}

type SuccessfulDeploymentContext = {
  status: string;
  project_id: number | string;
  environment_type: string | null;
  image_digest: string | null;
};

type PreviousDeploymentContext = {
  id: number | string;
  project_id: number | string;
  status: string;
  environment_type: string | null;
  image_digest: string | null;
};

/**
 * 공개 URL 검증까지 끝난 배포를 실제 서비스 Origin으로 기록한다.
 * AWS→On-Prem이고 digest가 같을 때만 직전 AWS 배포를 명시적 Failover 대상으로 보존한다.
 */
export async function activateVerifiedDeployment(
  pool: Pool,
  deploymentId: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query<SuccessfulDeploymentContext>(
      `SELECT deployment.status, deployment.project_id,
              environment.type AS environment_type,
              artifact.image_digest
       FROM deployments AS deployment
       LEFT JOIN environments AS environment ON environment.id = deployment.target_environment_id
       LEFT JOIN build_artifacts AS artifact ON artifact.deployment_id = deployment.id
       WHERE deployment.id = $1
       FOR UPDATE OF deployment`,
      [deploymentId],
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new Error(`activateVerifiedDeployment: deployment ${deploymentId} not found`);
    }
    if (current.status !== "verifying" && current.status !== "rollback") {
      throw new Error(
        `activateVerifiedDeployment: invalid transition ${current.status} → succeeded for deployment ${deploymentId}`,
      );
    }

    const projectResult = await client.query<{ active_deployment_id: number | string | null }>(
      `SELECT active_deployment_id
       FROM projects
       WHERE id = $1
       FOR UPDATE`,
      [current.project_id],
    );
    if (!projectResult.rows[0]) {
      throw new Error(`activateVerifiedDeployment: project ${String(current.project_id)} not found`);
    }

    let previousId = projectResult.rows[0].active_deployment_id;
    if (previousId === null) {
      const previousResult = await client.query<{ id: number | string }>(
        `SELECT id
         FROM deployments
         WHERE project_id = $1 AND id <> $2 AND status = 'succeeded'
         ORDER BY succeeded_at DESC NULLS LAST, id DESC
         LIMIT 1`,
        [current.project_id, deploymentId],
      );
      previousId = previousResult.rows[0]?.id ?? null;
    }

    let failoverTargetId: number | null = null;
    if (previousId !== null && current.environment_type === "onprem") {
      const previousResult = await client.query<PreviousDeploymentContext>(
        `SELECT deployment.id, deployment.project_id, deployment.status,
                environment.type AS environment_type,
                artifact.image_digest
         FROM deployments AS deployment
         LEFT JOIN environments AS environment ON environment.id = deployment.target_environment_id
         LEFT JOIN build_artifacts AS artifact ON artifact.deployment_id = deployment.id
         WHERE deployment.id = $1`,
        [previousId],
      );
      const previous = previousResult.rows[0];
      if (
        previous &&
        String(previous.project_id) === String(current.project_id) &&
        previous.status === "succeeded" &&
        previous.environment_type === "aws" &&
        current.image_digest !== null &&
        current.image_digest === previous.image_digest
      ) {
        failoverTargetId = Number(previous.id);
      }
    }

    await client.query(
      `UPDATE deployments
       SET status = 'succeeded',
           updated_at = NOW(),
           succeeded_at = COALESCE(succeeded_at, NOW()),
           failover_target_deployment_id = $2
       WHERE id = $1`,
      [deploymentId, failoverTargetId],
    );
    await client.query(
      `UPDATE projects
       SET active_deployment_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [current.project_id, deploymentId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function scheduleOnpremRuntimeCleanup(
  deps: WorkerDeps,
  deploymentId: number,
  nextStatus: "succeeded" | "failed",
): Promise<void> {
  const current = await deps.pool.query<{ status: string }>(
    `SELECT status FROM deployments WHERE id = $1`,
    [deploymentId],
  );
  if (current.rows[0]?.status !== nextStatus) return;

  if (nextStatus === "failed") {
    await enqueueOnpremCleanup(deps.pool, {
      deploymentId,
      reason: "deployment_failed",
    });
    return;
  }

  // 새 Origin 검증까지 성공한 시점부터 직전 On-Prem 하나만 15분 rollback 후보로 둔다.
  // 그보다 오래된 런타임은 즉시 정리해 프로젝트별 active + standby 최대 2개를 지킨다.
  const previous = await deps.pool.query<{ id: number | string }>(
    `SELECT previous.id
     FROM deployments current
     JOIN deployments previous
       ON previous.project_id = current.project_id
      AND previous.id <> current.id
      AND previous.status = 'succeeded'
     JOIN onprem_agent_jobs job ON job.deployment_id = previous.id
     WHERE current.id = $1
     ORDER BY previous.succeeded_at DESC NULLS LAST, previous.id DESC`,
    [deploymentId],
  );
  const now = Date.now();
  const standbyAvailableAt = new Date(now + ONPREM_ROLLBACK_GRACE_MS);
  const immediateAvailableAt = new Date(now);
  for (const [index, row] of previous.rows.entries()) {
    await enqueueOnpremCleanup(deps.pool, {
      deploymentId: Number(row.id),
      reason: "superseded",
      availableAt: index === 0 ? standbyAvailableAt : immediateAvailableAt,
    });
  }
}

export async function claimVerifyStep(
  pool: Pool,
  payload: VerifyJobPayload,
): Promise<VerifyStepClaim> {
  const requestFingerprint = createVerifyRequestFingerprint(payload);
  const targetUrl = resolveHealthTargetUrl(payload);
  const initialMessage = JSON.stringify({
    jobId: payload.jobId,
    environmentId: payload.environmentId,
    requestFingerprint,
    phase: "target",
    ...(targetUrl ? { targetUrl } : {}),
  });
  const inserted = await pool.query<{ id: string | number }>(
    `INSERT INTO deployment_steps(
       deployment_id, step_name, status, job_id, message
     ) VALUES ($1, 'verify', 'running', $2, $3)
     ON CONFLICT (job_id)
       WHERE step_name = 'verify' AND job_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [payload.deploymentId, payload.jobId, initialMessage],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId !== undefined) {
    return { owned: true, stepId: Number(insertedId) };
  }

  const existingResult = await pool.query<ExistingVerifyStep>(
    `SELECT id, deployment_id, status, message
     FROM deployment_steps
     WHERE job_id = $1 AND step_name = 'verify'`,
    [payload.jobId],
  );
  const existing = existingResult.rows[0];
  if (!existing) throw new Error("verify step 조회에 실패함");

  if (
    Number(existing.deployment_id) !== payload.deploymentId ||
    readEnvironmentId(existing.message) !== payload.environmentId ||
    readRequestFingerprint(existing.message) !== requestFingerprint
  ) {
    throw new VerifyJobConflictError(payload.jobId);
  }

  const phase = readVerificationPhase(existing.message);
  const storedResult = parseStoredResult(existing.message);
  const targetResult = parseStoredTargetResult(existing.message);
  const activation = parseStoredActivation(existing.message);
  if (storedResult) {
    return {
      owned: false,
      stepId: Number(existing.id),
      result: storedResult,
      phase,
      completed:
        existing.status === "failed" ||
        (phase === "public_url" && existing.status === "succeeded"),
      ...(activation ? { activation } : {}),
    };
  }
  if (targetResult?.status === "passed") {
    return {
      owned: false,
      stepId: Number(existing.id),
      result: targetResult,
      phase,
      completed: false,
      ...(activation ? { activation } : {}),
    };
  }
  if (existing.status === "running") {
    throw new VerifyJobInProgressError(payload.jobId);
  }

  const reclaimed = await pool.query<{ id: string | number }>(
    `UPDATE deployment_steps
     SET status = 'running',
         started_at = NOW(),
         finished_at = NULL,
         duration_ms = NULL,
         message = $1
     WHERE id = $2 AND status = 'failed'
     RETURNING id`,
    [initialMessage, existing.id],
  );
  const reclaimedId = reclaimed.rows[0]?.id;
  if (reclaimedId === undefined) {
    throw new VerifyJobInProgressError(payload.jobId);
  }
  return { owned: true, stepId: Number(reclaimedId) };
}

function resolveHealthTargetUrl(payload: VerifyJobPayload): string | null {
  try {
    return buildHealthUrl(payload.targetUrl, payload.health.path);
  } catch {
    return null;
  }
}

export async function persistHealthCheckAttempt(
  pool: Pool,
  deploymentStepId: number,
  environmentId: string,
  check: HealthCheckAttempt,
  phase: VerificationAttemptPhase = "target",
): Promise<void> {
  await pool.query(
    `INSERT INTO health_check_attempts(
       deployment_step_id, environment_id, phase, attempt, checked_at,
       status_code, latency_ms, passed, error_code, error_message
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (deployment_step_id, environment_id, phase, attempt)
     DO UPDATE SET
       checked_at = EXCLUDED.checked_at,
       status_code = EXCLUDED.status_code,
       latency_ms = EXCLUDED.latency_ms,
       passed = EXCLUDED.passed,
       error_code = EXCLUDED.error_code,
       error_message = EXCLUDED.error_message`,
    [
      deploymentStepId,
      environmentId,
      phase,
      check.attempt,
      new Date(check.timestamp),
      check.statusCode ?? null,
      check.latencyMs ?? null,
      check.passed,
      toErrorCode(check.error),
      check.error ?? null,
    ],
  );
}

export async function finishVerifyStep(
  pool: Pool,
  deploymentStepId: number,
  result: VerifyResult,
  payload?: VerifyJobPayload,
  details: {
    phase?: VerificationPhase;
    targetResult?: VerifyResult;
    activation?: OriginActivationReceipt;
  } = {},
): Promise<void> {
  await pool.query(
    `UPDATE deployment_steps
     SET status = $1,
         finished_at = $2,
         duration_ms = $3,
         message = $4
     WHERE id = $5 AND status = 'running'`,
    [
      result.status === "passed" ? "succeeded" : "failed",
      new Date(result.finishedAt),
      result.durationMs,
      JSON.stringify({
        ...result,
        phase: details.phase ?? "target",
        targetUrl: sanitizeTargetUrl(result.targetUrl),
        ...(details.targetResult ? { targetResult: details.targetResult } : {}),
        ...(details.activation ? { activation: details.activation } : {}),
        ...(payload
          ? {
              jobId: payload.jobId,
              requestFingerprint: createVerifyRequestFingerprint(payload),
            }
          : {}),
      }),
      deploymentStepId,
    ],
  );
}

async function recordTargetVerifyPassed(
  pool: Pool,
  deploymentStepId: number,
  result: VerifyResult,
  payload: VerifyJobPayload,
): Promise<void> {
  await pool.query(
    `UPDATE deployment_steps
     SET message = $1
     WHERE id = $2 AND status = 'running'`,
    [
      JSON.stringify({
        jobId: payload.jobId,
        environmentId: payload.environmentId,
        requestFingerprint: createVerifyRequestFingerprint(payload),
        phase: "origin_switching",
        targetUrl: sanitizeTargetUrl(result.targetUrl),
        targetResult: result,
      }),
      deploymentStepId,
    ],
  );
}

async function recordPublicUrlPhase(
  pool: Pool,
  deploymentStepId: number,
  targetResult: VerifyResult,
  payload: VerifyJobPayload,
  activation: OriginActivationReceipt,
): Promise<void> {
  const targetUrl = buildHealthUrl(
    `https://${activation.serviceHostname}`,
    payload.health.path,
  );
  await pool.query(
    `UPDATE deployment_steps
     SET message = $1
     WHERE id = $2 AND status = 'running'`,
    [
      JSON.stringify({
        jobId: payload.jobId,
        environmentId: payload.environmentId,
        requestFingerprint: createVerifyRequestFingerprint(payload),
        phase: "public_url",
        targetUrl,
        targetResult,
        activation,
      }),
      deploymentStepId,
    ],
  );
}

async function rollbackOrigin(
  deps: WorkerDeps,
  deploymentId: number,
  activation: OriginActivationReceipt,
  reason = "final_url_verification_failed",
): Promise<boolean> {
  try {
    await transitionTo(deps.pool, deploymentId, "rollback", { reason });
    await deps.notifier?.notify(deploymentId, "state_changed", {
      status: "rollback",
    });
  } catch (error) {
    deps.log?.warn(
      { deployment_id: deploymentId, err: error },
      "verify rollback: rollback state transition skipped",
    );
  }

  try {
    await deps.originActivator?.rollback(activation);
  } catch (error) {
    deps.log?.warn(
      { deployment_id: deploymentId, err: error },
      "verify rollback: origin restore failed",
    );
    return false;
  }

  await finalizeDeploymentState(deps, deploymentId, "failed", reason);
  return true;
}

function internalFailureResult(
  payload: Pick<VerifyJobPayload, "deploymentId" | "environmentId">,
  targetUrl: string,
): VerifyResult {
  const timestamp = new Date().toISOString();
  return {
    deploymentId: payload.deploymentId,
    environmentId: payload.environmentId,
    status: "failed",
    targetUrl,
    checks: [],
    consecutivePassed: 0,
    requiredPasses: REQUIRED_PASSES,
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 0,
    failureReason: "verify_internal_error",
  };
}

function toErrorCode(error?: string): string | null {
  if (!error) return null;
  return error.split(":", 1)[0]?.trim().toUpperCase() || "NETWORK_ERROR";
}

function sanitizeTargetUrl(targetUrl: string): string {
  try {
    const url = new URL(targetUrl);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function parseStoredResult(message: string | null): VerifyResult | null {
  if (!message) return null;
  try {
    const parsed: unknown = JSON.parse(message);
    const result = VerifyResultSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function parseStoredTargetResult(message: string | null): VerifyResult | null {
  const parsed = parseMessageObject(message);
  if (!parsed) return null;
  const result = VerifyResultSchema.safeParse(Reflect.get(parsed, "targetResult"));
  return result.success ? result.data : null;
}

function readVerificationPhase(message: string | null): VerificationPhase {
  const parsed = parseMessageObject(message);
  if (!parsed) return "target";
  const phase = Reflect.get(parsed, "phase");
  return phase === "target" ||
      phase === "origin_switching" ||
      phase === "public_url"
    ? phase
    : "target";
}

function parseStoredActivation(
  message: string | null,
): OriginActivationReceipt | null {
  const parsed = parseMessageObject(message);
  if (!parsed) return null;
  const activation = Reflect.get(parsed, "activation");
  if (!activation || typeof activation !== "object" || Array.isArray(activation)) {
    return null;
  }
  const serviceHostname = Reflect.get(activation, "serviceHostname");
  const activatedOrigin = Reflect.get(activation, "activatedOrigin");
  const previousOrigin = Reflect.get(activation, "previousOrigin");
  const tunnelIngress = Reflect.get(activation, "tunnelIngress");
  if (typeof serviceHostname !== "string" || typeof activatedOrigin !== "string") {
    return null;
  }
  if (!isPreviousOrigin(previousOrigin) || !isTunnelIngress(tunnelIngress)) {
    return null;
  }
  return {
    serviceHostname,
    activatedOrigin,
    previousOrigin,
    tunnelIngress,
    ...(Reflect.get(activation, "reused") === true ? { reused: true as const } : {}),
  };
}

function isPreviousOrigin(
  value: unknown,
): value is OriginActivationReceipt["previousOrigin"] {
  if (value === null) return true;
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof Reflect.get(value, "hostname") === "string" &&
      typeof Reflect.get(value, "proxied") === "boolean",
  );
}

function isTunnelIngress(
  value: unknown,
): value is OriginActivationReceipt["tunnelIngress"] {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const previousServiceUrl = Reflect.get(value, "previousServiceUrl");
  return (
    typeof Reflect.get(value, "tunnelId") === "string" &&
    typeof Reflect.get(value, "hostname") === "string" &&
    typeof Reflect.get(value, "activatedServiceUrl") === "string" &&
    (previousServiceUrl === null || typeof previousServiceUrl === "string")
  );
}

function parseMessageObject(message: string | null): object | null {
  if (!message) return null;
  try {
    const parsed: unknown = JSON.parse(message);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function readEnvironmentId(message: string | null): string | null {
  if (!message) return null;
  try {
    const parsed: unknown = JSON.parse(message);
    if (parsed === null || typeof parsed !== "object") return null;
    const environmentId = Reflect.get(parsed, "environmentId");
    return typeof environmentId === "string" ? environmentId : null;
  } catch {
    return null;
  }
}

function readRequestFingerprint(message: string | null): string | null {
  if (!message) return null;
  try {
    const parsed: unknown = JSON.parse(message);
    if (parsed === null || typeof parsed !== "object") return null;
    const fingerprint = Reflect.get(parsed, "requestFingerprint");
    return typeof fingerprint === "string" ? fingerprint : null;
  } catch {
    return null;
  }
}

export function createVerifyRequestFingerprint(
  payload: VerifyJobPayload,
): string {
  const canonical = JSON.stringify({
    deploymentId: payload.deploymentId,
    environmentId: payload.environmentId,
    environmentType: payload.environmentType,
    serviceId: payload.serviceId,
    targetUrl: payload.targetUrl,
    health: payload.health,
    expectedDigest: payload.expectedDigest ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
