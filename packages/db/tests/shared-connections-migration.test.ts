import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "012_shared_connections.sql",
);

async function readMigration() {
  return readFile(migrationPath, "utf8");
}

describe("012_shared_connections migration", () => {
  it("environments · secrets 의 project_id 를 NULL 허용으로 바꾼다", async () => {
    const sql = await readMigration();

    expect(sql).toMatch(/ALTER TABLE environments ALTER COLUMN project_id DROP NOT NULL/i);
    expect(sql).toMatch(/ALTER TABLE secrets ALTER COLUMN project_id DROP NOT NULL/i);
  });

  it("공용 연결의 이름 · 종류별 기본값 · 공용 시크릿 이름을 부분 유니크 인덱스로 제한한다", async () => {
    const sql = await readMigration();

    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_environments_shared_name[\s\S]+ON environments\(name\)[\s\S]+WHERE project_id IS NULL;/i,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_environments_shared_default_per_vendor[\s\S]+ON environments\(type\)[\s\S]+WHERE project_id IS NULL AND is_default = TRUE/i,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS uq_secrets_shared_name[\s\S]+ON secrets\(name\)[\s\S]+WHERE project_id IS NULL/i,
    );
  });

  it("기존 row 를 바꾸거나 지우지 않는다", async () => {
    const sql = (await readMigration()).replace(/--.*$/gm, "");

    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP TABLE|TRUNCATE)\b/i);
  });
});
