import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "015_project_deletion.sql",
);

describe("015_project_deletion migration (#247)", () => {
  it("projects 에 삭제 상태 · 이유 · 요청 시각 · 경고 컬럼을 더한다", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS deletion_status TEXT[\s\S]+CHECK \(deletion_status IN \('deleting', 'failed'\)\)/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS deletion_error TEXT/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS deletion_warnings TEXT\[\] NOT NULL DEFAULT '\{\}'/i);
  });

  it("기존 row 를 바꾸거나 지우지 않는다", async () => {
    const sql = (await readFile(migrationPath, "utf8")).replace(/--.*$/gm, "");

    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i);
  });
});
