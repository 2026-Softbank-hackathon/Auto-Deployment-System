import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { activeJobCount, createShutdown, DRAIN_TIMEOUT_MS, trackActive } from "../src/shutdown.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeHarness() {
  const order: string[] = [];
  const job = deferred();
  const handler = trackActive(async () => {
    await job.promise;
    order.push("job finished");
  });
  // pg-boss stop({ graceful: true }) 처럼 진행 중인 작업이 끝나야 resolve 된다
  let running: Promise<void> = Promise.resolve();
  const boss = {
    stop: vi.fn(async () => {
      await running;
      order.push("boss stopped");
    }),
  };
  const pool = { end: vi.fn(async () => { order.push("pool ended"); }) };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const exit = vi.fn((code: number) => { order.push(`exit ${code}`); });
  return {
    order, job, boss, pool, log, exit,
    startJob: () => { running = handler([]); return running; },
  };
}

describe("worker graceful shutdown", () => {
  it("SIGTERM 을 받으면 새 작업을 받지 않고 진행 중인 작업이 끝날 때까지 기다린 뒤 종료한다", async () => {
    const h = makeHarness();
    void h.startJob();
    const shutdown = createShutdown({ boss: h.boss, pool: h.pool, log: h.log, exit: h.exit });

    const done = shutdown("SIGTERM");
    await new Promise((r) => setTimeout(r, 20));

    expect(h.boss.stop).toHaveBeenCalledWith({ graceful: true, timeout: DRAIN_TIMEOUT_MS });
    expect(h.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ signal: "SIGTERM", activeJobs: 1 }),
      expect.stringContaining("draining 1 active job"),
    );
    expect(h.exit).not.toHaveBeenCalled();
    expect(h.pool.end).not.toHaveBeenCalled();

    h.job.resolve();
    await done;

    expect(h.order).toEqual(["job finished", "boss stopped", "pool ended", "exit 0"]);
  });

  it("드레인 시간 안에 끝나지 않은 작업이 있으면 경고를 남기고 DB 연결을 기다리지 않고 종료한다", async () => {
    const h = makeHarness();
    void h.startJob();
    h.boss.stop.mockImplementation(async () => { h.order.push("boss stopped"); });
    const shutdown = createShutdown({ boss: h.boss, pool: h.pool, log: h.log, exit: h.exit });

    await shutdown("SIGTERM");

    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ activeJobs: 1 }),
      expect.stringContaining("drain timed out"),
    );
    expect(h.pool.end).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(1);
    h.job.resolve();
  });

  it("드레인 중 다시 받은 신호는 무시한다", async () => {
    const h = makeHarness();
    void h.startJob();
    const shutdown = createShutdown({ boss: h.boss, pool: h.pool, log: h.log, exit: h.exit });

    const first = shutdown("SIGTERM");
    await shutdown("SIGINT");

    expect(h.boss.stop).toHaveBeenCalledTimes(1);
    expect(h.exit).not.toHaveBeenCalled();
    h.job.resolve();
    await first;
    expect(h.exit).toHaveBeenCalledTimes(1);
  });

  it("작업이 실패해도 진행 중 작업 수를 되돌린다", async () => {
    const failing = trackActive(async () => { throw new Error("boom"); });
    await expect(failing([])).rejects.toThrow("boom");
    const h = makeHarness();
    const shutdown = createShutdown({ boss: h.boss, pool: h.pool, log: h.log, exit: h.exit });
    await shutdown("SIGTERM");
    expect(h.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ activeJobs: 0 }),
      expect.any(String),
    );
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("드레인을 시작하면 하트비트에 draining 을 남기고, DB 연결을 닫기 전에 하트비트를 멈춘다 (#308)", async () => {
    const h = makeHarness();
    void h.startJob();
    const heartbeat = {
      markDraining: vi.fn(async () => { h.order.push("heartbeat draining"); }),
      stop: vi.fn(async () => { h.order.push("heartbeat stopped"); }),
    };
    const shutdown = createShutdown({ boss: h.boss, pool: h.pool, log: h.log, exit: h.exit, heartbeat });

    const done = shutdown("SIGTERM");
    await new Promise((r) => setTimeout(r, 20));
    expect(heartbeat.markDraining).toHaveBeenCalledTimes(1);
    expect(heartbeat.stop).not.toHaveBeenCalled();

    h.job.resolve();
    await done;
    expect(h.order).toEqual(["heartbeat draining", "job finished", "boss stopped", "heartbeat stopped", "pool ended", "exit 0"]);
  });

  it("하트비트 기록이 실패해도 드레인 · 종료는 그대로 한다", async () => {
    const h = makeHarness();
    const heartbeat = {
      markDraining: vi.fn(async () => { throw new Error("db down"); }),
      stop: vi.fn(async () => { throw new Error("db down"); }),
    };
    const shutdown = createShutdown({ boss: h.boss, pool: h.pool, log: h.log, exit: h.exit, heartbeat });

    await shutdown("SIGTERM");
    expect(h.boss.stop).toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("진행 중인 작업 수를 하트비트용으로 읽을 수 있다", async () => {
    const job = deferred();
    const handler = trackActive(async () => { await job.promise; });
    const before = activeJobCount();
    const running = handler([]);
    expect(activeJobCount()).toBe(before + 1);
    job.resolve();
    await running;
    expect(activeJobCount()).toBe(before);
  });

  it("compose 의 worker stop_grace_period 가 드레인 시간보다 길다", async () => {
    const compose = await readFile(
      new URL("../../../infra/platform/compose.yaml", import.meta.url),
      "utf8",
    );
    const worker = compose.slice(compose.indexOf("\n  worker:"), compose.indexOf("\n  buildkit:"));
    const match = worker.match(/stop_grace_period:\s*(\d+)m\b/);
    expect(match).not.toBeNull();
    expect(Number(match![1]) * 60 * 1000).toBeGreaterThan(DRAIN_TIMEOUT_MS);
    expect(DRAIN_TIMEOUT_MS).toBeGreaterThanOrEqual(20 * 60 * 1000);
  });
});
