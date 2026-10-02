/**
 * apps/api/tests/ops-service.integration.test.ts
 * 운영 화면 조회(#308)를 실제 PostgreSQL · pg-boss 로 확인한다 — pg-boss 테이블 구조 · 24시간 집계 ·
 * KST 오늘 · 5분 추이 · 중단된 배포 판정이 SQL 에서 맞는지.
 * OPS_TEST_DATABASE_URL 이 없으면 건너뜀. 예: postgres://postgres:postgres@localhost:5441/postgres
 */

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import PgBoss from "pg-boss";
import { Pool } from "@camellia/db";
import { OpsAiUsageSchema, OpsDeployListSchema, OpsQueueSchema, OpsServerSchema } from "@camellia/contracts";
import { OpsService } from "../src/services/ops-service.js";

const databaseUrl = process.env["OPS_TEST_DATABASE_URL"];
const suffix = randomUUID().replaceAll("-", "");
const schema = `ops_test_${suffix}`;
const bossSchema = `ops_boss_${suffix}`;
const migrations = new URL("../../../packages/db/migrations/", import.meta.url);
let admin: Pool;
let pool: Pool;
let boss: PgBoss;
let svc: OpsService;
let deploymentId: number;
let projectId: number;

describe.skipIf(!databaseUrl)("운영 화면 조회: 실제 PostgreSQL · pg-boss", () => {
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of (await readdir(migrations)).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(file, migrations), "utf8"));
    }
    svc = new OpsService(pool, bossSchema);

    const project = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ('ops-app') RETURNING id`);
    projectId = Number(project.rows[0]!.id);
    const deployment = await pool.query<{ id: string }>(
      `INSERT INTO deployments (project_id, status) VALUES ($1, 'analyzing') RETURNING id`,
      [projectId],
    );
    deploymentId = Number(deployment.rows[0]!.id);

    boss = new PgBoss({ connectionString: databaseUrl, schema: bossSchema, supervise: false, schedule: false });
    await boss.start();
    for (const name of ["analyze", "build", "teardown", "verify"]) await boss.createQueue(name);
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false, wait: true }).catch(() => {});
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
    await admin?.end();
  });

  it("queue — 큐마다 대기 · 진행 · 24시간 완료(보관함 포함) · 실패, 진행 중 작업의 배포 · 프로젝트, 최근 워커", async () => {
    await boss.send("analyze", { deployment_id: deploymentId });
    await boss.send("analyze", { deployment_id: deploymentId });
    const [running] = await boss.fetch("analyze");
    expect(running).toBeDefined();

    await boss.send("build", { deployment_id: deploymentId });
    const [built] = await boss.fetch("build");
    await boss.complete("build", built!.id);
    await boss.send("build", { deployment_id: deploymentId });
    const [built2] = await boss.fetch("build");
    await boss.complete("build", built2!.id);
    // 완료 작업 하나는 보관함(archive)으로 — pg-boss 유지보수가 옮긴 것과 같게
    await pool.query(
      `WITH moved AS (DELETE FROM ${bossSchema}.job WHERE id = $1 RETURNING *)
       INSERT INTO ${bossSchema}.archive SELECT moved.*, now() FROM moved`,
      [built2!.id],
    );
    // 25시간 전에 끝난 작업은 세지 않는다
    await boss.send("build", { deployment_id: deploymentId });
    const [old] = await boss.fetch("build");
    await boss.complete("build", old!.id);
    await pool.query(`UPDATE ${bossSchema}.job SET completed_on = now() - interval '25 hours' WHERE id = $1`, [old!.id]);

    await boss.send("teardown", { project_id: projectId }, { retryLimit: 0 });
    const [torn] = await boss.fetch("teardown");
    await boss.fail("teardown", torn!.id, new Error("boom"));

    await pool.query(
      `INSERT INTO worker_heartbeats (worker_id, hostname, commit_sha, started_at, last_seen_at, draining, active_jobs) VALUES
         ('w-new', 'host-b', 'abc1234', now() - interval '1 hour', now() - interval '5 seconds', false, 1),
         ('w-old', 'host-a', NULL, now() - interval '2 hours', now() - interval '5 minutes', true, 0),
         ('w-gone', 'host-z', NULL, now() - interval '3 hours', now() - interval '11 minutes', false, 0)`,
    );

    const result = await svc.queue();
    expect(OpsQueueSchema.safeParse(result).success).toBe(true);

    expect(result.queues.map((q) => q.name)).toEqual(["analyze", "build", "verify", "teardown"]);
    const byName = Object.fromEntries(result.queues.map((q) => [q.name, q]));
    expect(byName["analyze"]).toMatchObject({ created: 1, retry: 0, active: 1, completed24h: 0, failed24h: 0 });
    expect(byName["analyze"]!.oldestWaitingSeconds).toBeGreaterThanOrEqual(0);
    expect(byName["build"]).toMatchObject({ created: 0, active: 0, completed24h: 2, failed24h: 0, oldestWaitingSeconds: null });
    expect(byName["teardown"]).toMatchObject({ failed24h: 1, completed24h: 0 });
    expect(byName["verify"]).toMatchObject({ created: 0, active: 0, completed24h: 0, failed24h: 0 });

    expect(result.activeJobs).toEqual([
      expect.objectContaining({ id: running!.id, name: "analyze", deploymentId: String(deploymentId), projectId: String(projectId) }),
    ]);

    expect(result.workers.map((w) => [w.workerId, w.online, w.draining])).toEqual([
      ["w-new", true, false],
      ["w-old", false, true],
    ]);
    expect(result.workers[0]!.uptimeSeconds).toBeGreaterThanOrEqual(3600);
    expect(result.workers[0]!.commit).toBe("abc1234");
  });

  it("server — 최신 값 · 마지막 빌드 캐시 · 5분 단위 추이 · 디스크 경고", async () => {
    await pool.query(
      `INSERT INTO platform_metrics (sampled_at, cpu_percent, mem_used_bytes, mem_total_bytes, load1, load5, load15, disk_used_bytes, disk_total_bytes, build_cache_bytes) VALUES
         (now() - interval '25 hours', 99, 100, 100, 9, 9, 9, 100, 100, NULL),
         (now() - interval '20 minutes', 10, 4000, 8000, 0.5, 0.4, 0.3, 30, 100, 5000000000),
         (now() - interval '30 seconds', 20, 5000, 8000, 0.7, 0.5, 0.3, 81, 100, NULL)`,
    );

    const result = await svc.server();
    expect(OpsServerSchema.safeParse(result).success).toBe(true);
    expect(result.latest).toMatchObject({ cpuPercent: 20, memUsedBytes: 5000, memPercent: 62.5, diskPercent: 81, load1: 0.7 });
    expect(result.latest!.sampledSecondsAgo).toBeGreaterThanOrEqual(29);
    expect(result.buildCache?.bytes).toBe(5000000000);
    expect(result.series.length).toBeGreaterThanOrEqual(1);
    expect(result.series.length).toBeLessThanOrEqual(2);
    expect(result.series.every((p) => p.disk <= 81)).toBe(true);
    expect(result.warnings).toEqual([{ code: "DISK_HIGH", percent: 81, threshold: 80 }]);
  });

  it("aiUsage — KST 오늘 · 최근 7일, 모델 · 목적별(목적 없는 예전 기록은 unknown), 최근 호출의 프로젝트", async () => {
    await pool.query(
      `INSERT INTO ai_usage (deployment_id, model, input_tokens, output_tokens, estimated_cost_usd, purpose, created_at) VALUES
         ($1, 'claude-sonnet-5-5', 100, 50, 0.0007, 'diagnosis', now()),
         ($1, 'claude-opus-5-5', 1000, 200, 0.008, 'analysis_fill', (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul') - interval '1 hour'),
         (NULL, 'claude-opus-5-5', 10, 5, 0.0001, NULL, now() - interval '2 days'),
         (NULL, 'claude-opus-5-5', 999, 999, 9, 'sqlite_patch', now() - interval '8 days')`,
      [deploymentId],
    );

    const result = await svc.aiUsage();
    expect(OpsAiUsageSchema.safeParse(result).success).toBe(true);
    expect(result.today).toEqual({ calls: 1, inputTokens: 100, outputTokens: 50, costUsd: 0.0007 });
    expect(result.last7d).toEqual({ calls: 3, inputTokens: 1110, outputTokens: 255, costUsd: 0.0088 });
    expect(new Date(result.todayStartsAt).getUTCHours()).toBe(15);
    expect(result.byModel.map((m) => [m.model, m.calls])).toEqual([["claude-opus-5-5", 2], ["claude-sonnet-5-5", 1]]);
    expect(result.byPurpose.map((p) => p.purpose).sort()).toEqual(["analysis_fill", "diagnosis", "unknown"]);
    expect(result.recent[0]).toMatchObject({ purpose: "diagnosis", deploymentId: String(deploymentId), projectId: String(projectId) });
    expect(result.recent).toHaveLength(4);
  });

  it("deploys — 최신순, 걸린 시간 · 디스크, 75분 넘게 running 이면 중단됨", async () => {
    await pool.query(
      `INSERT INTO platform_deploys (deploy_key, status, ref, commit_sha, commit_subject, commit_url, started_at, finished_at, disk_used_before_bytes, disk_used_after_bytes, disk_total_bytes, run_id, run_url) VALUES
         ('k1', 'running', NULL, NULL, NULL, NULL, now() - interval '3 hours', NULL, NULL, NULL, NULL, NULL, NULL),
         ('k2', 'success', 'abc', 'abc1234', '웹 추가', 'https://github.com/o/r/commit/abc1234', now() - interval '2 hours', now() - interval '2 hours' + interval '312 seconds', 14000000000, 13000000000, 40000000000, '42', 'https://github.com/o/r/actions/runs/42'),
         ('k3', 'running', 'def', 'def5678', 'API', NULL, now() - interval '1 minute', NULL, 13000000000, NULL, 40000000000, NULL, NULL)`,
    );

    const result = await svc.deploys();
    expect(OpsDeployListSchema.safeParse(result).success).toBe(true);
    expect(result.items.map((d) => d.status)).toEqual(["running", "success", "interrupted"]);
    expect(result.items[0]!.durationSeconds).toBeGreaterThanOrEqual(59);
    expect(result.items[1]).toMatchObject({ durationSeconds: 312, diskUsedBeforeBytes: 14000000000, diskUsedAfterBytes: 13000000000, runId: "42" });
    expect(result.items[2]!.durationSeconds).toBeNull();
  });
});
