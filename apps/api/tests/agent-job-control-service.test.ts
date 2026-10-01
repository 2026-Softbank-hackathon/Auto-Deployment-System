import { describe, expect, it, vi } from "vitest";
import type { Pool } from "@camellia/db";
import { AgentJobService } from "../src/services/agent-job-service.js";

const digest = `sha256:${"a".repeat(64)}`;
const repositoryUri =
  "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/4";
const payload = {
  jobId: "73",
  attempt: 1,
  deploymentId: 73,
  environmentId: "12",
  plan: {
    service: { name: "api" },
    health: { path: "/health", expectedStatus: 200, timeoutSeconds: 3 },
  },
  image: {
    repositoryUri,
    digest,
    platform: "linux/amd64",
    registryType: "ecr",
    region: "ap-northeast-2",
  },
};

const ownedJob = {
  job_id: "73",
  attempt: 1,
  deployment_id: 73,
  environment_id: 12,
  status: "running",
  result: null,
  payload,
  project_id: 4,
  deployment_status: "deploying",
  registry_aws_config: {
    credentialsType: "access_key",
    accessKeyIdSecretName: "AWS_ACCESS_KEY_ID",
    secretAccessKeySecretName: "AWS_SECRET_ACCESS_KEY",
    region: "ap-northeast-2",
  },
};

function makePool(
  handler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number },
): Pool {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const result = handler(sql.replace(/\s+/g, " ").trim(), params);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  });
  return {
    query,
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
  } as unknown as Pool;
}

const failedResult = {
  deploymentId: 73,
  environmentId: "12",
  jobId: "73",
  status: "failed" as const,
  imageUri: `${repositoryUri}@${digest}`,
  runningDigest: digest,
  errorCode: "health_check_failed",
  errorMessage: "로컬 endpoint 헬스체크에 실패했습니다.",
  startedAt: "2026-10-01T00:00:00.000Z",
  finishedAt: "2026-10-01T00:00:08.000Z",
};

describe("AgentJobService 실행 경계", () => {
  it("heartbeat가 소유 Job의 lease를 갱신하고 취소 상태를 함께 반환한다", async () => {
    const pool = makePool((sql) => ({
      rows: sql.includes("WITH current_job AS")
        ? [{ lease_renewed: true, job_cancelled: false }]
        : [],
    }));
    const service = new AgentJobService(pool);

    await expect(service.heartbeat(7, 12, "73", 90)).resolves.toEqual({
      leaseRenewed: true,
      jobCancelled: false,
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("job.lease_owner_id = $3"),
      ["73", 12, 7, 90],
    );
  });

  it("동적 포트로 ingress와 검증용 CNAME을 구성한 뒤 Tunnel token을 반환한다", async () => {
    const pool = makePool((sql) => ({
      rows: sql.includes("FROM onprem_agent_jobs AS job") ? [ownedJob] : [],
    }));
    const tunnelManager = {
      ensureNamedTunnel: vi.fn(async () => ({
        id: "tunnel-4",
        endpoint: "tunnel-4.cfargotunnel.com",
      })),
      setTunnelOrigin: vi.fn(async () => undefined),
      ensureCname: vi.fn(async () => ({})),
      getTunnelToken: vi.fn(async () => "temporary-tunnel-token"),
    };
    const service = new AgentJobService(pool, {
      tunnelManager,
      cloudflareZoneId: "zone-id",
      platformDomain: "camellia-deploy.app",
    });

    const session = await service.prepareTunnel(7, 12, "73", {
      deploymentId: 73,
      environmentId: "12",
      localPort: 49_152,
    });

    expect(tunnelManager.ensureNamedTunnel).toHaveBeenCalledWith("4");
    expect(tunnelManager.setTunnelOrigin).toHaveBeenCalledWith({
      tunnelId: "tunnel-4",
      hostname: "verify-d73.camellia-deploy.app",
      serviceUrl: "http://127.0.0.1:49152",
    });
    expect(tunnelManager.ensureCname).toHaveBeenCalledWith({
      zoneId: "zone-id",
      hostname: "verify-d73.camellia-deploy.app",
      target: "tunnel-4.cfargotunnel.com",
      proxied: true,
    });
    expect(session).toEqual({
      tunnelId: "tunnel-4",
      hostname: "verify-d73.camellia-deploy.app",
      token: "temporary-tunnel-token",
    });
  });

  it("ready_for_verify 결과를 저장하고 기존 Verify queue 계약으로 전달한다", async () => {
    const pool = makePool((sql) => {
      if (sql.includes("FROM onprem_agent_jobs AS job")) return { rows: [ownedJob] };
      if (sql.includes("UPDATE onprem_agent_jobs")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const send = vi.fn(async () => null);
    const service = new AgentJobService(pool, {
      platformDomain: "camellia-deploy.app",
      boss: { send } as never,
    });
    const result = {
      deploymentId: 73,
      environmentId: "12",
      jobId: "73",
      status: "ready_for_verify" as const,
      imageUri: `${repositoryUri}@${digest}`,
      runningDigest: digest,
      localUrl: "http://127.0.0.1:49152",
      endpoint: "https://verify-d73.camellia-deploy.app",
      startedAt: "2026-10-01T00:00:00.000Z",
      finishedAt: "2026-10-01T00:00:01.000Z",
    };

    await service.reportResult(7, 12, "73", result);

    expect(send).toHaveBeenCalledWith("verify", {
      jobId: "verify-deployment-73",
      attempt: 1,
      deploymentId: 73,
      environmentId: "12",
      environmentType: "onprem",
      serviceId: "api",
      targetUrl: "https://verify-d73.camellia-deploy.app",
      health: { path: "/health", expectedStatus: 200, timeoutMs: 3_000 },
      expectedDigest: digest,
    });
  });

  it("Agent 실패 결과와 Deployment 실패 및 환경 락 해제를 한 트랜잭션으로 반영한다", async () => {
    const queries: string[] = [];
    const pool = makePool((sql) => {
      queries.push(sql);
      if (sql.includes("FROM onprem_agent_jobs AS job")) return { rows: [ownedJob] };
      if (sql.includes("UPDATE onprem_agent_jobs")) return { rows: [{ job_id: "73" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const service = new AgentJobService(pool);

    await service.reportResult(7, 12, "73", failedResult);

    const begin = queries.indexOf("BEGIN");
    const updateJob = queries.findIndex((sql) => sql.includes("UPDATE onprem_agent_jobs"));
    const updateDeployment = queries.findIndex((sql) => sql.includes("UPDATE deployments"));
    const unlock = queries.findIndex((sql) => sql.includes("DELETE FROM env_locks"));
    const commit = queries.indexOf("COMMIT");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(begin).toBeLessThan(updateJob);
    expect(updateJob).toBeLessThan(updateDeployment);
    expect(updateDeployment).toBeLessThan(unlock);
    expect(unlock).toBeLessThan(commit);
  });

  it("동일한 실패 결과 재전송 시 남아 있는 환경 락을 멱등하게 정리한다", async () => {
    const failedJob = {
      ...ownedJob,
      status: "failed",
      result: failedResult,
      deployment_status: "failed",
    };
    const pool = makePool((sql) => ({
      rows: sql.includes("FROM onprem_agent_jobs AS job") ? [failedJob] : [],
      rowCount: 1,
    }));
    const service = new AgentJobService(pool);

    await service.reportResult(7, 12, "73", failedResult);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM env_locks"),
      [73],
    );
  });

  it("환경 락 해제에 실패하면 Agent 실패 결과 전체를 롤백한다", async () => {
    const queries: string[] = [];
    const pool = makePool((sql) => {
      queries.push(sql);
      if (sql.includes("FROM onprem_agent_jobs AS job")) return { rows: [ownedJob] };
      if (sql.includes("UPDATE onprem_agent_jobs")) return { rows: [{ job_id: "73" }], rowCount: 1 };
      if (sql.includes("DELETE FROM env_locks")) throw new Error("unlock failed");
      return { rows: [], rowCount: 1 };
    });
    const service = new AgentJobService(pool);

    await expect(service.reportResult(7, 12, "73", failedResult)).rejects.toThrow("unlock failed");

    expect(queries).toContain("ROLLBACK");
    expect(queries).not.toContain("COMMIT");
  });

  it("다른 Agent에게 할당된 Job의 Tunnel 정보를 반환하지 않는다", async () => {
    const pool = makePool(() => ({ rows: [] }));
    const service = new AgentJobService(pool);

    await expect(service.prepareTunnel(99, 12, "73", {
      deploymentId: 73,
      environmentId: "12",
      localPort: 49_152,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "AGENT_JOB_NOT_OWNED",
    });
  });
});
