import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations", "020_source_patches.sql");

describe("020_source_patches migration (#277)", () => {
  it("배포마다 하나인 수정안 테이블을 만든다 (배포가 지워지면 같이 지워짐)", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS source_patches/);
    expect(sql).toMatch(/deployment_id BIGINT NOT NULL UNIQUE REFERENCES deployments\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/CHECK \(status IN \('pending', 'approved', 'rejected'\)\)/);
    expect(sql).toMatch(/patched_storage_key TEXT NOT NULL/);
  });

  it("기존 row 를 바꾸거나 지우지 않는다", async () => {
    const sql = (await readFile(migrationPath, "utf8")).replace(/--.*$/gm, "").replace(/ON DELETE CASCADE/g, "");

    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i);
  });
});
