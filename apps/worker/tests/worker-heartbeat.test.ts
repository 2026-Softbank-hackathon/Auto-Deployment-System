import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerHeartbeat } from "../src/worker-heartbeat.js";

function makeDeps(activeJobs = 0) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: [] };
    }),
  };
  const log = { warn: vi.fn() };
  let jobs = activeJobs;
  return {
    queries,
    pool,
    log,
    setJobs: (n: number) => { jobs = n; },
    deps: {
      pool,
      log,
      workerId: "w-1",
      hostname: "abc123",
      commit: "deadbeef",
      startedAt: new Date("2026-10-02T00:00:00.000Z"),
      activeJobs: () => jobs,
      intervalMs: 10_000,
    },
  };
}

describe("worker heartbeat (#308)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("시작하면 바로 한 번, 이후 10초마다 worker_heartbeats 에 upsert 한다", async () => {
    const h = makeDeps(2);
    const hb = createWorkerHeartbeat(h.deps);

    await hb.start();
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]!.sql).toMatch(/INSERT INTO worker_heartbeats/);
    expect(h.queries[0]!.sql).toMatch(/ON CONFLICT \(worker_id\) DO UPDATE/);
    expect(h.queries[0]!.params).toEqual(["w-1", "abc123", "deadbeef", new Date("2026-10-02T00:00:00.000Z"), false, 2]);

    h.setJobs(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.queries).toHaveLength(2);
    expect(h.queries[1]!.params.at(-1)).toBe(0);

    await hb.stop();
  });

  it("드레인을 시작하면 draining=true 로 바로 남기고 이후 하트비트도 draining 을 유지한다", async () => {
    const h = makeDeps(1);
    const hb = createWorkerHeartbeat(h.deps);
    await hb.start();

    await hb.markDraining();
    expect(h.queries.at(-1)!.params[4]).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.queries.at(-1)!.params[4]).toBe(true);
    await hb.stop();
  });

  it("멈추면 마지막으로 한 번 남기고 더는 기록하지 않는다", async () => {
    const h = makeDeps();
    const hb = createWorkerHeartbeat(h.deps);
    await hb.start();
    await hb.stop();
    const count = h.queries.length;
    expect(count).toBe(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.queries).toHaveLength(count);
  });

  it("DB 오류는 경고만 남기고 워커를 멈추지 않는다", async () => {
    const h = makeDeps();
    h.pool.query.mockRejectedValue(new Error("connection refused"));
    const hb = createWorkerHeartbeat(h.deps);

    await expect(hb.start()).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.log.warn).toHaveBeenCalled();
    await expect(hb.stop()).resolves.toBeUndefined();
  });
});
