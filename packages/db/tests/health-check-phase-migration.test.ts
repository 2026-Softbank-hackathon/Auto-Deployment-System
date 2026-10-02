import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(
  __dirname,
  "..",
  "migrations",
  "012_health_check_attempt_phase.sql",
);

describe("012 health check phase migration", () => {
  it("기존 시도를 target으로 보존하고 허용 phase를 제한한다", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toMatch(/ADD COLUMN phase VARCHAR\(32\) NOT NULL DEFAULT 'target'/i);
    expect(sql).toMatch(/CHECK\s*\(phase IN \('target', 'public_url'\)\)/i);
  });

  it("phase별 attempt 번호 중복을 분리한다", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toMatch(
      /DROP CONSTRAINT(?: IF EXISTS)? health_check_attempts_deployment_step_id_environment_id_attempt_key/i,
    );
    expect(sql).toMatch(
      /UNIQUE\s*\(\s*deployment_step_id\s*,\s*environment_id\s*,\s*phase\s*,\s*attempt\s*\)/i,
    );
  });
});
