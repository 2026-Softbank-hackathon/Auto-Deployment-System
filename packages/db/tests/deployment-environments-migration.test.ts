import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "006_deployment_environments.sql",
);

async function readMigration() {
  return readFile(migrationPath, "utf8");
}

describe("006_deployment_environments migration", () => {
  it("vendor별 default Environment를 하나로 제한한다", async () => {
    const sql = await readMigration();

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS is_default BOOLEAN/i);
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_environments_default_per_vendor[\s\S]+ON environments\(project_id, type\)[\s\S]+WHERE is_default = TRUE/i,
    );
  });

  it("Deployment가 target과 registry Environment를 참조한다", async () => {
    const sql = await readMigration();

    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS target_environment_id BIGINT[\s\S]+REFERENCES environments\(id\) ON DELETE RESTRICT/i,
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS registry_environment_id BIGINT[\s\S]+REFERENCES environments\(id\) ON DELETE RESTRICT/i,
    );
  });
});
