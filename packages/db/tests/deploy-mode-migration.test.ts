import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
  "019_deploy_mode.sql",
);

describe("019_deploy_mode migration (#282)", () => {
  it("앱에 배포 형태(기본 container)를 저장한다", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toMatch(
      /ALTER TABLE projects\s+ADD COLUMN IF NOT EXISTS deploy_mode TEXT NOT NULL DEFAULT 'container'/i,
    );
    expect(sql).toMatch(/CHECK \(deploy_mode IN \('container', 'serverless'\)\)/i);
  });

  it("빌드 산출물에 Lambda Web Adapter 버전을 기록한다 (예전 이미지는 NULL)", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toMatch(/ALTER TABLE build_artifacts\s+ADD COLUMN IF NOT EXISTS lambda_web_adapter TEXT/i);
  });

  it("기존 row 를 바꾸거나 지우지 않는다", async () => {
    const sql = (await readFile(migrationPath, "utf8")).replace(/--.*$/gm, "");

    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|TRUNCATE)\b/i);
  });
});
