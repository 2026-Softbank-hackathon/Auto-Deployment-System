/**
 * apps/worker/tests/platform-ops.integration.test.ts
 * 워커 하트비트 · 호스트 지표 샘플러(#308)의 SQL 을 실제 PostgreSQL(025 마이그레이션)로 확인한다.
 * OPS_TEST_DATABASE_URL 이 없으면 건너뜀. 예: postgres://postgres:postgres@localhost:5441/postgres
 */

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "@camellia/db";
import { createWorkerHeartbeat } from "../src/worker-heartbeat.js";
import { createHostMetricsSampler } from "../src/host-metrics.js";

const databaseUrl = process.env["OPS_TEST_DATABASE_URL"];
const schema = `ops_worker_test_${randomUUID().replaceAll("-", "")}`;
const migrations = new URL("../../../packages/db/migrations/", import.meta.url);
let admin: Pool;
let pool: Pool;

describe.skipIf(!databaseUrl)("플랫폼 운영 기록: 실제 PostgreSQL", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of (await readdir(migrations)).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(file, migrations), "utf8"));
    }
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("하트비트는 한 워커에 한 행을 갱신하고 드레인을 남긴다", async () => {
    let jobs = 2;
    const log = { warn: vi.fn() };
    const hb = createWorkerHeartbeat({
      pool, log, workerId: "w-int", hostname: "host", commit: "abc", startedAt: new Date(Date.now() - 60_000),
      activeJobs: () => jobs, intervalMs: 60_000,
    });
    await hb.start();
    jobs = 1;
    await hb.markDraining();
    await hb.stop();

    const rows = await pool.query(`SELECT worker_id, commit_sha, draining, active_jobs FROM worker_heartbeats`);
    expect(rows.rows).toEqual([{ worker_id: "w-int", commit_sha: "abc", draining: true, active_jobs: 1 }]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("샘플러는 지표 행을 남기고 24시간 지난 지표 · 하트비트를 지운다", async () => {
    await pool.query(
      `INSERT INTO platform_metrics (sampled_at, mem_used_bytes, mem_total_bytes, load1, load5, load15, disk_used_bytes, disk_total_bytes)
       VALUES (now() - interval '25 hours', 1, 2, 0, 0, 0, 1, 2)`,
    );
    await pool.query(
      `INSERT INTO worker_heartbeats (worker_id, hostname, started_at, last_seen_at) VALUES ('w-dead', 'h', now() - interval '2 days', now() - interval '25 hours')`,
    );
    const log = { warn: vi.fn() };
    const sampler = createHostMetricsSampler({
      pool,
      log,
      readText: async (file) => ({
        "/proc/stat": "cpu  100 0 50 800 50 0 0 0 0 0\n",
        "/proc/meminfo": "MemTotal: 8000 kB\nMemAvailable: 6000 kB\n",
        "/proc/loadavg": "0.1 0.2 0.3 1/1 1\n",
      } as Record<string, string>)[file]!,
      statfs: async () => ({ bsize: 4096, blocks: 10_000_000, bfree: 2_000_000 }),
      buildCacheBytes: async () => 5_622_057_098,
    });
    await sampler.sample();

    expect(log.warn).not.toHaveBeenCalled();
    const metrics = await pool.query(`SELECT cpu_percent, mem_used_bytes, disk_used_bytes, build_cache_bytes FROM platform_metrics`);
    expect(metrics.rows).toEqual([{ cpu_percent: null, mem_used_bytes: String(2000 * 1024), disk_used_bytes: String(8_000_000 * 4096), build_cache_bytes: "5622057098" }]);
    const workers = await pool.query(`SELECT worker_id FROM worker_heartbeats ORDER BY worker_id`);
    expect(workers.rows.map((r) => r.worker_id)).toEqual(["w-int"]);
  });
});
