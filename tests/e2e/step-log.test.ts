/**
 * tests/e2e/step-log.test.ts
 * LOG-02 워커 단계 로그 → API 로그 조회 통합 — 실제 Postgres + 실제 LocalStorage.
 * 워커(stepLogKey)와 API(LogService)의 로그 파일 경로 규칙이 어긋나지 않는지 검증한다.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "@camellia/db";
import { LocalStorage } from "@camellia/storage";
import { createStepLogger } from "../../apps/worker/src/step-log.js";
import { LogService } from "../../apps/api/src/services/log-service.js";

const describeWithPostgres =
  process.env["SKIP_E2E"] === "true" ? describe.skip : describe;

describeWithPostgres("단계 로그 실제 스토리지 통합", () => {
  let pool: Pool;
  let rootDir: string;
  let storage: LocalStorage;
  let projectId: number;
  let deploymentId: number;

  beforeAll(async () => {
    pool = createPool(process.env["DATABASE_URL"]!);
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "step-log-e2e-"));
    storage = new LocalStorage({ rootDir });

    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects(name) VALUES ($1) RETURNING id`,
      [`step-log-e2e-${crypto.randomUUID()}`],
    );
    projectId = Number(project.rows[0]!.id);
    const deployment = await pool.query<{ id: string }>(
      `INSERT INTO deployments(project_id, status) VALUES ($1, 'building') RETURNING id`,
      [projectId],
    );
    deploymentId = Number(deployment.rows[0]!.id);
  });

  afterAll(async () => {
    if (projectId) {
      await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
    }
    await pool?.end();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("워커가 남긴 단계 로그를 API 로그 조회로 읽음", async () => {
    const logger = createStepLogger({ storage }, deploymentId, "build");
    await logger.line("docker build 시작");
    await logger.line("ECR push 완료");

    const result = await new LogService(pool, storage).get(deploymentId, "build");

    expect(result.hasContent).toBe(true);
    const lines = result.hasContent ? result.text.split("\n") : [];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] docker build 시작$/);
    expect(lines[1]).toMatch(/ECR push 완료$/);
  });
});
