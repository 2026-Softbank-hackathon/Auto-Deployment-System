import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(
  __dirname,
  "..",
  "migrations",
  "002_health_check_attempts.sql"
);

async function readMigration() {
  return readFile(migrationPath, "utf8");
}

describe("002_health_check_attempts migration", () => {
  it("시도별 헬스체크 테이블을 생성함", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/CREATE TABLE(?: IF NOT EXISTS)? health_check_attempts/i);
  });

  it("deployment_steps 외래키와 cascade 삭제를 보장함", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/REFERENCES deployment_steps\s*\(id\)/i);
    expect(sql).toMatch(/ON DELETE CASCADE/i);
  });

  it("환경별 시도 번호 중복을 방지함", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(
      /UNIQUE\s*\(\s*deployment_step_id\s*,\s*environment_id\s*,\s*attempt\s*\)/i
    );
  });

  it("시도 번호·상태 코드·지연 시간의 경계 제약을 포함함", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/CHECK\s*\(\s*attempt\s*>=\s*1\s*\)/i);
    expect(sql).toMatch(/status_code\s+BETWEEN\s+100\s+AND\s+599/i);
    expect(sql).toMatch(/latency_ms\s*>=\s*0/i);
  });
});
