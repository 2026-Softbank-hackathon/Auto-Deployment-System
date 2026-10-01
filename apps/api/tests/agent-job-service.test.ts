import { describe, expect, it, vi } from "vitest";
import type { Pool } from "@camellia/db";
import { AgentJobService } from "../src/services/agent-job-service.js";

const payload = {
  jobId: "not-authoritative",
  attempt: 1,
  deploymentId: 1,
  environmentId: "1",
  plan: { target: "onprem" },
  image: { digest: `sha256:${"a".repeat(64)}` },
};

function makePool(rows: unknown[]): Pool {
  return {
    query: vi.fn(async () => ({ rows, rowCount: rows.length })),
  } as unknown as Pool;
}

describe("AgentJobService.claimNext", () => {
  it("atomic skip-locked claim payload를 DB 컬럼 값으로 정규화한다", async () => {
    const pool = makePool([{
      job_id: "73",
      attempt: 2,
      deployment_id: "73",
      environment_id: "18",
      payload,
    }]);
    const service = new AgentJobService(pool);

    const job = await service.claimNext(4, 18, 90);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("FOR UPDATE OF job SKIP LOCKED"),
      [18, 4, 90],
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("deployment.status = 'deploying'"),
      expect.any(Array),
    );
    expect(job).toMatchObject({
      jobId: "73",
      attempt: 2,
      deploymentId: 73,
      environmentId: "18",
      plan: { target: "onprem" },
      image: { digest: `sha256:${"a".repeat(64)}` },
    });
  });

  it("claim 가능한 job이 없으면 null을 반환한다", async () => {
    const pool = makePool([]);
    const job = await new AgentJobService(pool).claimNext(4, 18);
    expect(job).toBeNull();
  });

  it("형식이 깨진 저장 payload를 거부한다", async () => {
    const pool = makePool([{
      job_id: "73",
      attempt: 1,
      deployment_id: 73,
      environment_id: 18,
      payload: { jobId: "broken" },
    }]);
    await expect(new AgentJobService(pool).claimNext(4, 18)).rejects.toThrow(
      "AGENT_JOB_PAYLOAD_INVALID",
    );
  });
});

describe("AgentJobService.renewLease", () => {
  it("현재 환경과 소유 Agent의 실행 중 Job lease만 연장한다", async () => {
    const pool = makePool([]);
    const service = new AgentJobService(pool);

    const renewed = await service.renewLease(4, 18, "73", 90);

    expect(renewed).toBe(false);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("job.lease_owner_id = $3"),
      ["73", 18, 4, 90],
    );
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("deployment.status = 'deploying'"),
      expect.any(Array),
    );
  });
});
