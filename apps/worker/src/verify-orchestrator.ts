import { createHash } from "node:crypto";
import type { Pool } from "@camellia/db";
import type { WorkerDeps } from "./deps.js";
import {
  buildHealthUrl,
  handleVerify,
  type HealthCheckAttempt,
  type VerifyJobPayload,
  type VerifyResult,
  type VerifyRuntime,
  VerifyJobPayloadSchema,
  VerifyResultSchema,
} from "./handlers/verify.js";

type VerifyStepClaim =
  | { owned: true; stepId: number }
  | { owned: false; stepId: number; result: VerifyResult };

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
  if (!claim.owned) return claim.result;
  const { stepId } = claim;

  try {
    const result = await handleVerify(validJob, deps, {
      ...runtime,
      onAttempt: (attempt) =>
        persistHealthCheckAttempt(
          deps.pool,
          stepId,
          validJob.data.environmentId,
          attempt,
        ),
    });
    await finishVerifyStep(deps.pool, stepId, result, validJob.data);
    return result;
  } catch (error) {
    await failVerifyStep(deps.pool, stepId, error);
    throw error;
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

  const storedResult = parseStoredResult(existing.message);
  if (storedResult) {
    return {
      owned: false,
      stepId: Number(existing.id),
      result: storedResult,
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
): Promise<void> {
  await pool.query(
    `INSERT INTO health_check_attempts(
       deployment_step_id, environment_id, attempt, checked_at,
       status_code, latency_ms, passed, error_code, error_message
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (deployment_step_id, environment_id, attempt)
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
        targetUrl: sanitizeTargetUrl(result.targetUrl),
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

async function failVerifyStep(
  pool: Pool,
  deploymentStepId: number,
  _error: unknown,
): Promise<void> {
  await pool.query(
    `UPDATE deployment_steps
     SET status = 'failed',
         finished_at = NOW(),
         duration_ms = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::INTEGER),
         message = $1
     WHERE id = $2`,
    ["verify_internal_error", deploymentStepId],
  );
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
