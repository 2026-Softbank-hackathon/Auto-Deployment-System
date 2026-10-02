import { describe, expect, it, vi } from "vitest";
import type { Pool } from "@camellia/db";
import { AgentCleanupJobService } from "../src/services/agent-cleanup-job-service.js";

const claimedRow = {
  job_id: "cleanup-73",
  attempt: 1,
  deployment_id: 73,
  environment_id: 12,
  reason: "project_deleted",
  status: "claimed",
  lease_owner_id: 7,
  result: null,
};

function makePool(
  handler: (sql: string, params: unknown[]) => { rows: unknown[]; rowCount?: number },
): Pool {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const result = handler(sql.replace(/\s+/g, " ").trim(), params);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  });
  return { query } as unknown as Pool;
}

describe("AgentCleanupJobService", () => {
  it("예약 시각이 지난 pending cleanup Job을 해당 Environment Agent에 lease한다", async () => {
    const pool = makePool((sql) => ({
      rows: sql.startsWith("WITH candidate AS") ? [claimedRow] : [],
    }));
    const service = new AgentCleanupJobService(pool);

    await expect(service.claimNext(7, 12, 90)).resolves.toEqual({
      jobId: "cleanup-73",
      attempt: 1,
      deploymentId: 73,
      environmentId: "12",
      reason: "project_deleted",
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("cleanup.environment_id = $1"),
      [12, 7, 90],
    );
  });

  it("cleanup 성공 결과를 멱등하게 완료 처리한다", async () => {
    const result = {
      jobId: "cleanup-73",
      attempt: 1,
      deploymentId: 73,
      environmentId: "12",
      reason: "project_deleted" as const,
      status: "succeeded" as const,
      startedAt: "2026-10-02T00:00:00.000Z",
      finishedAt: "2026-10-02T00:00:01.000Z",
    };
    const pool = makePool((sql) => {
      if (sql.startsWith("SELECT job_id")) return { rows: [claimedRow] };
      if (sql.startsWith("UPDATE onprem_agent_cleanup_jobs")) {
        return { rows: [{ job_id: "cleanup-73" }], rowCount: 1 };
      }
      return { rows: [] };
    });
    const service = new AgentCleanupJobService(pool);

    await expect(service.reportResult(7, 12, "cleanup-73", result)).resolves.toBeUndefined();
    expect(pool.query).toHaveBeenLastCalledWith(
      expect.stringContaining("status = 'succeeded'"),
      [JSON.stringify(result), "cleanup-73", 7],
    );
  });

  it("cleanup 실패는 5회 전까지 backoff 후 pending으로 되돌린다", async () => {
    const result = {
      jobId: "cleanup-73",
      attempt: 2,
      deploymentId: 73,
      environmentId: "12",
      reason: "project_deleted" as const,
      status: "failed" as const,
      errorCode: "cleanup_failed" as const,
      errorMessage: "docker unavailable",
      startedAt: "2026-10-02T00:00:00.000Z",
      finishedAt: "2026-10-02T00:00:01.000Z",
    };
    const pool = makePool((sql) => {
      if (sql.startsWith("SELECT job_id")) return { rows: [{ ...claimedRow, attempt: 2 }] };
      return { rows: [{ job_id: "cleanup-73" }], rowCount: 1 };
    });
    const service = new AgentCleanupJobService(pool);

    await service.reportResult(7, 12, "cleanup-73", result);

    expect(pool.query).toHaveBeenLastCalledWith(
      expect.stringContaining("status = CASE WHEN attempt >= 5 THEN 'failed' ELSE 'pending' END"),
      [JSON.stringify(result), "cleanup_failed", "cleanup-73", 7],
    );
  });
});
