import type { Pool } from "@camellia/db";
import type { WorkerDeps } from "./deps.js";
import {
  handleVerify,
  type HealthCheckAttempt,
  type VerifyJobPayload,
  type VerifyResult,
  type VerifyRuntime,
} from "./handlers/verify.js";

export async function runVerifyJob(
  job: { data: VerifyJobPayload },
  deps: WorkerDeps,
  runtime: Pick<VerifyRuntime, "sleep" | "signal"> = {
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  },
): Promise<VerifyResult> {
  const stepId = await startVerifyStep(deps.pool, job.data.deploymentId);

  try {
    const result = await handleVerify(job, deps, {
      ...runtime,
      onAttempt: (attempt) =>
        persistHealthCheckAttempt(
          deps.pool,
          stepId,
          job.data.environmentId,
          attempt,
        ),
    });
    await finishVerifyStep(deps.pool, stepId, result);
    return result;
  } catch (error) {
    await failVerifyStep(deps.pool, stepId, error);
    throw error;
  }
}

export async function startVerifyStep(
  pool: Pool,
  deploymentId: number,
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO deployment_steps(deployment_id, step_name, status)
     VALUES ($1, 'verify', 'running')
     RETURNING id`,
    [deploymentId],
  );
  const stepId = result.rows[0]?.id;
  if (!stepId) throw new Error("verify step 생성에 실패함");
  return stepId;
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
): Promise<void> {
  await pool.query(
    `UPDATE deployment_steps
     SET status = $1,
         finished_at = $2,
         duration_ms = $3,
         message = $4
     WHERE id = $5`,
    [
      result.status === "passed" ? "succeeded" : "failed",
      new Date(result.finishedAt),
      result.durationMs,
      JSON.stringify({
        ...result,
        targetUrl: sanitizeTargetUrl(result.targetUrl),
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
