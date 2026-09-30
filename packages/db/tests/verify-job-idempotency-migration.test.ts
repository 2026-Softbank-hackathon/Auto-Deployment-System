import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(
  __dirname,
  "..",
  "migrations",
  "003_verify_job_idempotency.sql",
);

async function readMigration() {
  return readFile(migrationPath, "utf8");
}

describe("003_verify_job_idempotency migration", () => {
  it("deployment_steps에 queue job 식별자를 추가함", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(
      /ALTER TABLE deployment_steps[\s\S]+ADD COLUMN(?: IF NOT EXISTS)? job_id/i,
    );
  });

  it("verify job ID의 부분 unique index를 생성함", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/CREATE UNIQUE INDEX/i);
    expect(sql).toMatch(/ON deployment_steps\s*\(job_id\)/i);
    expect(sql).toMatch(/WHERE[\s\S]+step_name\s*=\s*'verify'/i);
  });
});
