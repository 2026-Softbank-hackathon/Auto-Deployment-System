import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import { ApiError } from "../plugins/error-handler.js";

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

type OwnedJobRow = ClaimRow & {
  status: string;
  result: unknown;
  project_id: number | string;
  deployment_status: string;
};

export type AgentTunnelInput = {
  deploymentId: number;
  environmentId: string;
  localPort: number;
};

export type AgentTunnelSession = {
  tunnelId: string;
  token: string;
  hostname: string;
};

type AgentExecutionResultBase = {
  deploymentId: number;
  environmentId: string;
  jobId: string;
  imageUri: string;
  startedAt: string;
  finishedAt: string;
};

export type AgentExecutionResult = AgentExecutionResultBase & (
  | {
      status: "ready_for_verify";
      runningDigest: string;
      localUrl: string;
      endpoint: string;
    }
  | {
      status: "failed";
      runningDigest?: string;
      localUrl?: string;
      errorCode: string;
      errorMessage: string;
    }
);

export type TunnelManager = {
  ensureNamedTunnel(serviceId: string): Promise<{
    id: string;
    endpoint: string;
  }>;
  getTunnelToken(tunnelId: string): Promise<string>;
  setTunnelOrigin(input: {
    tunnelId: string;
    hostname: string;
    serviceUrl: string;
  }): Promise<void>;
  ensureCname(input: {
    zoneId: string;
    hostname: string;
    target: string;
    proxied?: boolean;
  }): Promise<unknown>;
};

export type AgentJobServiceOptions = {
  tunnelManager?: TunnelManager;
  cloudflareZoneId?: string;
  platformDomain?: string;
  boss?: Pick<PgBoss, "send">;
};

export class AgentJobService {
  constructor(
    private readonly pool: Pool,
    private readonly options: AgentJobServiceOptions = {},
  ) {}

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

  async heartbeat(
    agentId: number,
    environmentId: number,
    jobId: string,
    leaseSeconds = 90,
  ): Promise<{ leaseRenewed: boolean; jobCancelled: boolean }> {
    const result = await this.pool.query<{
      lease_renewed: boolean;
      job_cancelled: boolean;
    }>(
      `WITH current_job AS (
         SELECT deployment.status AS deployment_status
         FROM onprem_agent_jobs AS job
         JOIN deployments AS deployment ON deployment.id = job.deployment_id
         WHERE job.job_id = $1
           AND job.environment_id = $2
           AND job.lease_owner_id = $3
           AND job.status IN ('claimed', 'running')
           AND job.lease_expires_at > NOW()
       ), renewed AS (
         UPDATE onprem_agent_jobs AS job
         SET status = 'running',
             lease_expires_at = NOW() + ($4 * INTERVAL '1 second'),
             updated_at = NOW()
         FROM current_job
         WHERE job.job_id = $1
           AND current_job.deployment_status = 'deploying'
         RETURNING job.job_id
       )
       SELECT EXISTS(SELECT 1 FROM renewed) AS lease_renewed,
              COALESCE(
                (SELECT deployment_status = 'cancelled' FROM current_job),
                FALSE
              ) AS job_cancelled`,
      [jobId, environmentId, agentId, Math.max(1, Math.min(leaseSeconds, 300))],
    );
    const row = result.rows[0];
    return {
      leaseRenewed: row?.lease_renewed === true,
      jobCancelled: row?.job_cancelled === true,
    };
  }

  async prepareTunnel(
    agentId: number,
    environmentId: number,
    jobId: string,
    input: AgentTunnelInput,
  ): Promise<AgentTunnelSession> {
    const job = await this.loadOwnedJob(agentId, environmentId, jobId, true);
    this.assertJobIdentity(job, input.deploymentId, input.environmentId, jobId);
    const manager = this.options.tunnelManager;
    const zoneId = this.options.cloudflareZoneId;
    const platformDomain = this.options.platformDomain?.replace(/^\.+|\.+$/g, "");
    if (!manager || !zoneId || !platformDomain) {
      throw new ApiError(
        503,
        "TUNNEL_NOT_CONFIGURED",
        "Cloudflare Tunnel이 설정되지 않았습니다.",
      );
    }

    try {
      const tunnel = await manager.ensureNamedTunnel(String(job.project_id));
      const hostname = `verify-d${input.deploymentId}.${platformDomain}`;
      await manager.setTunnelOrigin({
        tunnelId: tunnel.id,
        hostname,
        serviceUrl: `http://127.0.0.1:${input.localPort}`,
      });
      await manager.ensureCname({
        zoneId,
        hostname,
        target: tunnel.endpoint,
        proxied: true,
      });
      const token = await manager.getTunnelToken(tunnel.id);
      return { tunnelId: tunnel.id, hostname, token };
    } catch {
      throw new ApiError(
        502,
        "TUNNEL_PREPARE_FAILED",
        "Cloudflare Tunnel 준비에 실패했습니다.",
      );
    }
  }

  async reportResult(
    agentId: number,
    environmentId: number,
    jobId: string,
    result: AgentExecutionResult,
  ): Promise<void> {
    const job = await this.loadOwnedJob(agentId, environmentId, jobId, false);
    this.assertJobIdentity(job, result.deploymentId, result.environmentId, result.jobId);
    const payload = parsePayload(job.payload);
    const image = parseImage(payload.image);
    if (result.imageUri !== `${image.repositoryUri}@${image.digest}`) {
      throw new ApiError(409, "AGENT_RESULT_CONFLICT", "실행 이미지가 Job과 일치하지 않습니다.");
    }

    if (["ready_for_verify", "failed", "cancelled"].includes(job.status)) {
      if (stableJson(job.result) === stableJson(result)) {
        if (job.status === "ready_for_verify" && result.status === "ready_for_verify") {
          await this.enqueueVerify(payload, image, result);
        }
        if (result.status === "failed") {
          await this.pool.query(`DELETE FROM env_locks WHERE deployment_id = $1`, [
            result.deploymentId,
          ]);
        }
        return;
      }
      throw new ApiError(409, "AGENT_RESULT_CONFLICT", "이미 제출된 Job 결과와 일치하지 않습니다.");
    }

    if (result.status === "failed") {
      const cancelled = result.errorCode === "cancelled" || job.deployment_status === "cancelled";
      await this.recordFailedResult(agentId, jobId, result, cancelled);
      return;
    }

    if (
      job.deployment_status !== "deploying" ||
      result.runningDigest !== image.digest ||
      !result.endpoint ||
      new URL(result.endpoint).hostname !== this.verificationHostname(result.deploymentId)
    ) {
      throw new ApiError(409, "AGENT_RESULT_CONFLICT", "검증 준비 결과가 Job과 일치하지 않습니다.");
    }
    if (!this.options.boss) {
      throw new ApiError(503, "VERIFY_QUEUE_UNAVAILABLE", "Verify queue를 사용할 수 없습니다.");
    }

    const updated = await this.pool.query(
      `UPDATE onprem_agent_jobs
       SET status = 'ready_for_verify', result = $1::jsonb,
           lease_expires_at = NULL, updated_at = NOW()
       WHERE job_id = $2 AND lease_owner_id = $3
         AND status IN ('claimed', 'running')`,
      [JSON.stringify(result), jobId, agentId],
    );
    if ((updated.rowCount ?? 0) !== 1) {
      throw new ApiError(409, "AGENT_RESULT_CONFLICT", "Job 결과를 반영할 수 없습니다.");
    }
    await this.pool.query(
      `UPDATE deployments
       SET status = 'verifying', public_url = $1, updated_at = NOW()
       WHERE id = $2 AND status = 'deploying'`,
      [result.endpoint, result.deploymentId],
    );
    await this.enqueueVerify(payload, image, result);
  }

  private async recordFailedResult(
    agentId: number,
    jobId: string,
    result: Extract<AgentExecutionResult, { status: "failed" }>,
    cancelled: boolean,
  ): Promise<void> {
    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE onprem_agent_jobs
         SET status = $1, result = $2::jsonb, lease_expires_at = NULL,
             error_code = $3, updated_at = NOW()
         WHERE job_id = $4 AND lease_owner_id = $5
           AND status IN ('claimed', 'running')
         RETURNING job_id`,
        [cancelled ? "cancelled" : "failed", JSON.stringify(result), result.errorCode, jobId, agentId],
      );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new ApiError(409, "AGENT_RESULT_CONFLICT", "Job 결과를 반영할 수 없습니다.");
      }
      if (!cancelled) {
        await client.query(
          `UPDATE deployments
           SET status = 'failed', failed_at = NOW(), updated_at = NOW(), error = $1
           WHERE id = $2 AND status = 'deploying'`,
          [result.errorCode, result.deploymentId],
        );
      }
      await client.query(`DELETE FROM env_locks WHERE deployment_id = $1`, [
        result.deploymentId,
      ]);
      await client.query("COMMIT");
      committed = true;
    } catch (error) {
      if (!committed) await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async enqueueVerify(
    payload: Omit<ClaimedOnpremJob, "jobId" | "attempt" | "deploymentId" | "environmentId">,
    image: { repositoryUri: string; digest: string; region: string },
    result: AgentExecutionResult & { status: "ready_for_verify" },
  ): Promise<void> {
    const plan = parseVerifyPlan(payload.plan);
    if (!this.options.boss) {
      throw new ApiError(503, "VERIFY_QUEUE_UNAVAILABLE", "Verify queue를 사용할 수 없습니다.");
    }
    await this.options.boss.send("verify", {
      jobId: `verify-deployment-${result.deploymentId}`,
      attempt: 1,
      deploymentId: result.deploymentId,
      environmentId: result.environmentId,
      environmentType: "onprem",
      serviceId: plan.serviceName,
      targetUrl: result.endpoint,
      health: {
        path: plan.healthPath,
        expectedStatus: plan.expectedStatus,
        timeoutMs: plan.timeoutSeconds * 1_000,
      },
      expectedDigest: image.digest,
    });
  }

  private verificationHostname(deploymentId: number): string {
    const platformDomain = this.options.platformDomain?.replace(/^\.+|\.+$/g, "");
    if (!platformDomain) {
      throw new ApiError(503, "TUNNEL_NOT_CONFIGURED", "플랫폼 도메인이 설정되지 않았습니다.");
    }
    return `verify-d${deploymentId}.${platformDomain}`;
  }

  private assertJobIdentity(
    job: OwnedJobRow,
    deploymentId: number,
    environmentId: string,
    jobId: string,
  ): void {
    if (
      job.job_id !== jobId ||
      Number(job.deployment_id) !== deploymentId ||
      String(job.environment_id) !== environmentId
    ) {
      throw new ApiError(409, "AGENT_JOB_MISMATCH", "Agent Job 식별자가 일치하지 않습니다.");
    }
  }

  private async loadOwnedJob(
    agentId: number,
    environmentId: number,
    jobId: string,
    requireActive: boolean,
  ): Promise<OwnedJobRow> {
    const result = await this.pool.query<OwnedJobRow>(
      `SELECT job.job_id, job.attempt, job.deployment_id, job.environment_id,
              job.status, job.payload, job.result, deployment.project_id,
              deployment.status AS deployment_status
       FROM onprem_agent_jobs AS job
       JOIN deployments AS deployment ON deployment.id = job.deployment_id
       WHERE job.job_id = $1
         AND job.environment_id = $2
         AND job.lease_owner_id = $3
         AND (
           ($4::boolean = TRUE
             AND job.status IN ('claimed', 'running')
             AND job.lease_expires_at > NOW()
             AND deployment.status = 'deploying')
           OR
           ($4::boolean = FALSE
             AND (
               job.status IN ('ready_for_verify', 'failed', 'cancelled')
               OR (
                 job.status IN ('claimed', 'running')
                 AND job.lease_expires_at > NOW()
               )
             ))
         )`,
      [jobId, environmentId, agentId, requireActive],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(409, "AGENT_JOB_NOT_OWNED", "실행 중인 할당 Job이 아닙니다.");
    }
    return row;
  }
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

function parseImage(value: unknown): {
  repositoryUri: string;
  digest: string;
  region: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(500, "AGENT_JOB_PAYLOAD_INVALID", "저장된 이미지 계약이 올바르지 않습니다.");
  }
  const image = value as Record<string, unknown>;
  if (
    typeof image.repositoryUri !== "string" ||
    typeof image.digest !== "string" ||
    typeof image.region !== "string"
  ) {
    throw new ApiError(500, "AGENT_JOB_PAYLOAD_INVALID", "저장된 이미지 계약이 올바르지 않습니다.");
  }
  return image as { repositoryUri: string; digest: string; region: string };
}

function parseVerifyPlan(value: unknown): {
  serviceName: string;
  healthPath: string;
  expectedStatus: number;
  timeoutSeconds: number;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(500, "AGENT_JOB_PAYLOAD_INVALID", "저장된 실행 계획이 올바르지 않습니다.");
  }
  const plan = value as Record<string, unknown>;
  const service = plan.service;
  const health = plan.health;
  if (
    !service || typeof service !== "object" || Array.isArray(service) ||
    !health || typeof health !== "object" || Array.isArray(health)
  ) {
    throw new ApiError(500, "AGENT_JOB_PAYLOAD_INVALID", "저장된 실행 계획이 올바르지 않습니다.");
  }
  const serviceRow = service as Record<string, unknown>;
  const healthRow = health as Record<string, unknown>;
  if (
    typeof serviceRow.name !== "string" ||
    typeof healthRow.path !== "string" ||
    typeof healthRow.expectedStatus !== "number" ||
    typeof healthRow.timeoutSeconds !== "number"
  ) {
    throw new ApiError(500, "AGENT_JOB_PAYLOAD_INVALID", "저장된 실행 계획이 올바르지 않습니다.");
  }
  return {
    serviceName: serviceRow.name,
    healthPath: healthRow.path,
    expectedStatus: healthRow.expectedStatus,
    timeoutSeconds: healthRow.timeoutSeconds,
  };
}
