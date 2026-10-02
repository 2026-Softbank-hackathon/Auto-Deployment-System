import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "016_terraform_inputs_hash.sql",
);

describe("016_terraform_inputs_hash migration (#252)", () => {
  it("deployments 에 Terraform 입력 지문 컬럼을 더한다", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toMatch(/ALTER TABLE deployments\s+ADD COLUMN IF NOT EXISTS terraform_inputs_hash TEXT/i);
  });

  it("기존 row 를 바꾸거나 지우지 않는다", async () => {
    const sql = (await readFile(migrationPath, "utf8")).replace(/--.*$/gm, "");

    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i);
  });
});
