import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "007_build_artifacts.sql",
);

async function readMigration() {
  return readFile(migrationPath, "utf8");
}

describe("007_build_artifacts migration", () => {
  it("deployment별 build 결과를 하나로 제한한다", async () => {
    const sql = await readMigration();

    expect(sql).toMatch(/deployment_id BIGINT NOT NULL UNIQUE/i);
    expect(sql).toMatch(/REFERENCES deployments\(id\) ON DELETE CASCADE/i);
  });

  it("sha256 digest와 immutable ref를 저장한다", async () => {
    const sql = await readMigration();

    expect(sql).toMatch(/image_digest TEXT NOT NULL/i);
    expect(sql).toMatch(/\^sha256:\[0-9a-f\]\{64\}\$/i);
    expect(sql).toMatch(/immutable_ref TEXT NOT NULL/i);
  });
});
