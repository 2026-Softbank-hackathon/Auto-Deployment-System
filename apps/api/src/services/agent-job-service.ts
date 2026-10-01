import type { Pool } from "@camellia/db";

export type ClaimedOnpremJob = {
  jobId: string;
  attempt: number;
  deploymentId: number;
  environmentId: string;
  plan: unknown;
  image: unknown;
  environment?: Record<string, string>;
};

type ClaimRow = {
  job_id: string;
  attempt: number;
  deployment_id: number | string;
  environment_id: number | string;
  payload: unknown;
};

export class AgentJobService {
  constructor(private readonly pool: Pool) {}

  async claimNext(
    agentId: number,
    environmentId: number,
    leaseSeconds = 90,
  ): Promise<ClaimedOnpremJob | null> {
    const result = await this.pool.query<ClaimRow>(
      `WITH candidate AS (
         SELECT job.job_id, job.status, job.lease_expires_at
         FROM onprem_agent_jobs job
         JOIN deployments deployment ON deployment.id = job.deployment_id
         WHERE job.environment_id = $1
           AND deployment.status = 'deploying'
           AND (
             job.status = 'pending'
             OR (
               job.status IN ('claimed', 'running')
               AND job.lease_expires_at <= NOW()
             )
           )
         ORDER BY job.created_at, job.id
         FOR UPDATE OF job SKIP LOCKED
         LIMIT 1
       )
       UPDATE onprem_agent_jobs AS job
       SET status = 'claimed',
           lease_owner_id = $2,
           lease_expires_at = NOW() + ($3 * INTERVAL '1 second'),
           attempt = job.attempt + CASE
             WHEN candidate.status IN ('claimed', 'running') THEN 1
             ELSE 0
           END,
           updated_at = NOW()
       FROM candidate
       WHERE job.job_id = candidate.job_id
       RETURNING job.job_id, job.attempt, job.deployment_id,
                 job.environment_id, job.payload`,
      [environmentId, agentId, Math.max(1, Math.min(leaseSeconds, 300))],
    );

    const row = result.rows[0];
    if (!row) return null;
    const payload = parsePayload(row.payload);
    return {
      ...payload,
      jobId: row.job_id,
      attempt: row.attempt,
      deploymentId: Number(row.deployment_id),
      environmentId: String(row.environment_id),
    };
  }

  async renewLease(
    agentId: number,
    environmentId: number,
    jobId: string,
    leaseSeconds = 90,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE onprem_agent_jobs AS job
       SET status = 'running',
           lease_expires_at = NOW() + ($4 * INTERVAL '1 second'),
           updated_at = NOW()
       FROM deployments AS deployment
       WHERE job.job_id = $1
         AND job.environment_id = $2
         AND job.lease_owner_id = $3
         AND job.status IN ('claimed', 'running')
         AND deployment.id = job.deployment_id
         AND deployment.status = 'deploying'`,
      [jobId, environmentId, agentId, Math.max(1, Math.min(leaseSeconds, 300))],
    );
    return (result.rowCount ?? 0) === 1;
  }
}

function parsePayload(value: unknown): Omit<ClaimedOnpremJob, "jobId" | "attempt" | "deploymentId" | "environmentId"> {
  const payload = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("AGENT_JOB_PAYLOAD_INVALID");
  }
  const row = payload as Record<string, unknown>;
  if (
    !row["plan"] ||
    typeof row["plan"] !== "object" ||
    !row["image"] ||
    typeof row["image"] !== "object"
  ) {
    throw new Error("AGENT_JOB_PAYLOAD_INVALID");
  }
  if (row["environment"] !== undefined && (
    !row["environment"] ||
    typeof row["environment"] !== "object" ||
    Array.isArray(row["environment"])
  )) {
    throw new Error("AGENT_JOB_PAYLOAD_INVALID");
  }
  return row as Omit<ClaimedOnpremJob, "jobId" | "attempt" | "deploymentId" | "environmentId">;
}
