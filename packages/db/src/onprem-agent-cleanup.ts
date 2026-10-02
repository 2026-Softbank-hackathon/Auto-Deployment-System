import type { Pool, PoolClient } from "pg";

export const ONPREM_CLEANUP_REASONS = [
  "superseded",
  "deployment_failed",
  "deployment_cancelled",
  "project_deleted",
] as const;

export type OnpremCleanupReason = (typeof ONPREM_CLEANUP_REASONS)[number];

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

/** 해당 배포가 On-Prem Agent Job을 가진 경우에만 cleanup Job을 생성하거나 앞당긴다. */
export async function enqueueOnpremCleanup(
  queryable: Queryable,
  input: {
    deploymentId: number;
    reason: OnpremCleanupReason;
    availableAt?: Date;
  },
): Promise<boolean> {
  const availableAt = input.availableAt ?? new Date();
  const result = await queryable.query(
    `INSERT INTO onprem_agent_cleanup_jobs (
       job_id, deployment_id, environment_id, reason, available_at
     )
     SELECT 'cleanup-' || job.deployment_id::text,
            job.deployment_id, job.environment_id, $2, $3
     FROM onprem_agent_jobs AS job
     WHERE job.deployment_id = $1
     ON CONFLICT (deployment_id) DO UPDATE
     SET reason = EXCLUDED.reason,
         available_at = LEAST(onprem_agent_cleanup_jobs.available_at, EXCLUDED.available_at),
         status = CASE
           WHEN onprem_agent_cleanup_jobs.status = 'succeeded' THEN 'succeeded'
           ELSE 'pending'
         END,
         lease_owner_id = CASE
           WHEN onprem_agent_cleanup_jobs.status = 'succeeded'
             THEN onprem_agent_cleanup_jobs.lease_owner_id
           ELSE NULL
         END,
         lease_expires_at = CASE
           WHEN onprem_agent_cleanup_jobs.status = 'succeeded'
             THEN onprem_agent_cleanup_jobs.lease_expires_at
           ELSE NULL
         END,
         updated_at = NOW()
     RETURNING job_id`,
    [input.deploymentId, input.reason, availableAt],
  );
  return (result.rowCount ?? 0) === 1;
}
