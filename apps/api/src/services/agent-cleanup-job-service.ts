import type { Pool } from "@camellia/db";
import type { OnpremCleanupReason } from "@camellia/db";
import { ApiError } from "../plugins/error-handler.js";

export type ClaimedCleanupJob = {
  jobId: string;
  attempt: number;
  deploymentId: number;
  environmentId: string;
  reason: OnpremCleanupReason;
};

export type CleanupExecutionResult = ClaimedCleanupJob & {
  status: "succeeded" | "failed";
  errorCode?: "cleanup_failed" | "internal_error";
  errorMessage?: string;
  startedAt: string;
  finishedAt: string;
};

type CleanupRow = {
  job_id: string;
  attempt: number;
  deployment_id: number | string;
  environment_id: number | string;
  reason: OnpremCleanupReason;
  status: string;
  lease_owner_id: number | string | null;
  result: unknown;
};

export class AgentCleanupJobService {
  constructor(private readonly pool: Pool) {}

  async claimNext(
    agentId: number,
    environmentId: number,
    leaseSeconds = 90,
  ): Promise<ClaimedCleanupJob | null> {
    const result = await this.pool.query<CleanupRow>(
      `WITH candidate AS (
         SELECT cleanup.id
         FROM onprem_agent_cleanup_jobs AS cleanup
         WHERE cleanup.environment_id = $1
           AND cleanup.available_at <= NOW()
           AND (
             cleanup.status = 'pending'
             OR (
               cleanup.status = 'claimed'
               AND cleanup.lease_expires_at <= NOW()
             )
           )
         ORDER BY cleanup.available_at, cleanup.id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE onprem_agent_cleanup_jobs AS cleanup
       SET status = 'claimed',
           attempt = cleanup.attempt + 1,
           lease_owner_id = $2,
           lease_expires_at = NOW() + ($3 * INTERVAL '1 second'),
           updated_at = NOW()
       FROM candidate
       WHERE cleanup.id = candidate.id
       RETURNING cleanup.job_id, cleanup.attempt, cleanup.deployment_id,
                 cleanup.environment_id, cleanup.reason, cleanup.status,
                 cleanup.lease_owner_id, cleanup.result`,
      [environmentId, agentId, Math.max(1, Math.min(leaseSeconds, 300))],
    );
    const row = result.rows[0];
    return row ? toClaimedCleanupJob(row) : null;
  }

  async reportResult(
    agentId: number,
    environmentId: number,
    jobId: string,
    result: CleanupExecutionResult,
  ): Promise<void> {
    const owned = await this.pool.query<CleanupRow>(
      `SELECT job_id, attempt, deployment_id, environment_id, reason,
              status, lease_owner_id, result
       FROM onprem_agent_cleanup_jobs
       WHERE job_id = $1
         AND environment_id = $2
         AND lease_owner_id = $3
         AND status IN ('claimed', 'succeeded')`,
      [jobId, environmentId, agentId],
    );
    const row = owned.rows[0];
    if (!row) {
      throw new ApiError(409, "AGENT_CLEANUP_JOB_NOT_OWNED", "할당된 cleanup Job이 아닙니다.");
    }
    assertCleanupIdentity(row, result, jobId);
    if (row.status === "succeeded") {
      if (stableJson(row.result) === stableJson(result)) return;
      throw new ApiError(409, "AGENT_CLEANUP_RESULT_CONFLICT", "이미 제출된 cleanup 결과와 일치하지 않습니다.");
    }

    if (result.status === "succeeded") {
      const updated = await this.pool.query(
        `UPDATE onprem_agent_cleanup_jobs
         SET status = 'succeeded', result = $1::jsonb,
             error_code = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE job_id = $2 AND lease_owner_id = $3 AND status = 'claimed'
         RETURNING job_id`,
        [JSON.stringify(result), jobId, agentId],
      );
      if ((updated.rowCount ?? 0) !== 1) throwResultConflict();
      return;
    }

    const updated = await this.pool.query(
      `UPDATE onprem_agent_cleanup_jobs
       SET status = CASE WHEN attempt >= 5 THEN 'failed' ELSE 'pending' END,
           result = $1::jsonb,
           error_code = $2,
           available_at = NOW() + (
             LEAST(60, CAST(POWER(2, attempt) AS INTEGER) * 5) * INTERVAL '1 second'
           ),
           lease_owner_id = NULL,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE job_id = $3 AND lease_owner_id = $4 AND status = 'claimed'
       RETURNING job_id`,
      [JSON.stringify(result), result.errorCode ?? "cleanup_failed", jobId, agentId],
    );
    if ((updated.rowCount ?? 0) !== 1) throwResultConflict();
  }
}

function toClaimedCleanupJob(row: CleanupRow): ClaimedCleanupJob {
  return {
    jobId: row.job_id,
    attempt: row.attempt,
    deploymentId: Number(row.deployment_id),
    environmentId: String(row.environment_id),
    reason: row.reason,
  };
}

function assertCleanupIdentity(
  row: CleanupRow,
  result: CleanupExecutionResult,
  jobId: string,
): void {
  if (
    result.jobId !== jobId ||
    result.attempt !== row.attempt ||
    result.deploymentId !== Number(row.deployment_id) ||
    result.environmentId !== String(row.environment_id) ||
    result.reason !== row.reason
  ) {
    throw new ApiError(409, "AGENT_CLEANUP_JOB_MISMATCH", "cleanup Job 식별자가 일치하지 않습니다.");
  }
}

function throwResultConflict(): never {
  throw new ApiError(409, "AGENT_CLEANUP_RESULT_CONFLICT", "cleanup 결과를 반영할 수 없습니다.");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
