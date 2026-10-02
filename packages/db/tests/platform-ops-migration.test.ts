import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("025_platform_ops migration (#308)", () => {
  it("워커 하트비트 · 서버 지표 · 플랫폼 배포 기록 테이블과 AI 사용 목적 컬럼을 만들고 기존 row 는 건드리지 않는다", async () => {
    const sql = await readFile(new URL("../migrations/025_platform_ops.sql", import.meta.url), "utf8");

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS worker_heartbeats/i);
    for (const column of ["worker_id TEXT PRIMARY KEY", "hostname TEXT NOT NULL", "commit_sha TEXT", "started_at TIMESTAMPTZ NOT NULL", "last_seen_at TIMESTAMPTZ NOT NULL", "draining BOOLEAN NOT NULL", "active_jobs INTEGER NOT NULL"]) {
      expect(sql).toContain(column);
    }

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS platform_metrics/i);
    for (const column of ["sampled_at TIMESTAMPTZ NOT NULL", "cpu_percent", "mem_used_bytes BIGINT NOT NULL", "mem_total_bytes BIGINT NOT NULL", "load1", "load5", "load15", "disk_used_bytes BIGINT NOT NULL", "disk_total_bytes BIGINT NOT NULL", "build_cache_bytes BIGINT"]) {
      expect(sql).toContain(column);
    }
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS \w+ ON platform_metrics \(sampled_at\)/i);

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS platform_deploys/i);
    expect(sql).toContain("deploy_key TEXT NOT NULL UNIQUE");
    expect(sql).toMatch(/status TEXT NOT NULL CHECK \(status IN \('running', 'success', 'failed'\)\)/);
    for (const column of ["commit_sha TEXT", "commit_subject TEXT", "commit_url TEXT", "finished_at TIMESTAMPTZ", "disk_used_before_bytes BIGINT", "disk_used_after_bytes BIGINT", "disk_total_bytes BIGINT", "run_id TEXT", "run_url TEXT"]) {
      expect(sql).toContain(column);
    }

    expect(sql).toMatch(/ALTER TABLE ai_usage\s+ADD COLUMN IF NOT EXISTS purpose TEXT\s+CHECK \(purpose IN \('analysis_fill', 'sqlite_patch', 'diagnosis'\)\)/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS \w+ ON ai_usage \(created_at\)/i);
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i);
  });
});
