/**
 * apps/api/tests/project-delete.integration.test.ts
 * 앱 삭제 요청 (#247) — 실제 PostgreSQL 에서 삭제 요청 SQL 과 목록의 deletion 을 확인한다.
 * PROJECT_DELETE_TEST_DATABASE_URL 이 있을 때만 실행 (격리 schema 생성 후 삭제).
 */

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool } from "@camellia/db";
import { MIGRATION_FILES } from "@camellia/db/migrations";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import { ProjectService } from "../src/services/project-service.js";
import { DeploymentService } from "../src/services/deployment-service.js";

const databaseUrl = process.env["PROJECT_DELETE_TEST_DATABASE_URL"];
const schema = `project_delete_test_${randomUUID().replaceAll("-", "")}`;
let admin: Pool;
let pool: Pool;

describe.skipIf(!databaseUrl)("앱 삭제 요청 (#247): isolated PostgreSQL", () => {
  const send = vi.fn(async () => "job");
  let projects: ProjectService;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of MIGRATION_FILES) {
      await pool.query(await readFile(new URL(`../../../packages/db/migrations/${file}`, import.meta.url), "utf8"));
    }
    projects = new ProjectService(pool, "example.com", { send } as unknown as PgBoss);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    send.mockClear();
    await pool.query("TRUNCATE deployments, environments, projects RESTART IDENTITY CASCADE");
  });

  async function project(): Promise<number> {
    const result = await pool.query<{ id: string }>("INSERT INTO projects(name) VALUES($1) RETURNING id", [randomUUID()]);
    return Number(result.rows[0]!.id);
  }

  async function deployment(projectId: number, status: string): Promise<number> {
    const result = await pool.query<{ id: string }>(
      "INSERT INTO deployments(project_id, status) VALUES($1, $2) RETURNING id",
      [projectId, status],
    );
    return Number(result.rows[0]!.id);
  }

  it("끝난 배포만 있으면 deleting 으로 바꾸고 목록에 보여준다 · 재요청은 요청 시각을 유지한다", async () => {
    const id = await project();
    await deployment(id, "succeeded");
    await deployment(id, "failed");

    const first = await projects.requestDeletion(id);
    const second = await projects.requestDeletion(id);

    expect(first.deletion).toMatchObject({ status: "deleting", error: null, warnings: [] });
    expect(second.deletion.requestedAt).toBe(first.deletion.requestedAt);
    expect(send).toHaveBeenCalledTimes(2);
    expect((await projects.get(id)).deletion).toEqual(first.deletion);
    expect((await projects.list({ limit: 20 })).items[0]!.deletion?.status).toBe("deleting");
  });

  it("실패 뒤 재요청하면 이유를 지우고 다시 deleting", async () => {
    const id = await project();
    await pool.query(
      `UPDATE projects SET deletion_status = 'failed', deletion_error = 'TERRAFORM_DESTROY_FAILED',
              deletion_requested_at = NOW() - INTERVAL '1 hour' WHERE id = $1`,
      [id],
    );

    const result = await projects.requestDeletion(id);

    expect(result.deletion).toMatchObject({ status: "deleting", error: null });
    expect(Date.now() - Date.parse(result.deletion.requestedAt)).toBeLessThan(60_000);
  });

  it("온프레미스 Agent 작업이 있던 앱은 ONPREM_MANUAL_CLEANUP 경고", async () => {
    const id = await project();
    const env = await pool.query<{ id: string }>(
      `INSERT INTO environments(project_id, name, type, onprem_config) VALUES($1, 'mac', 'onprem', '{}'::jsonb) RETURNING id`,
      [id],
    );
    const deploymentId = await deployment(id, "succeeded");
    await pool.query(
      `INSERT INTO onprem_agent_jobs(job_id, deployment_id, environment_id, status, payload)
       VALUES($1, $2, $3, 'ready_for_verify', '{}'::jsonb)`,
      [String(deploymentId), deploymentId, env.rows[0]!.id],
    );

    expect((await projects.requestDeletion(id)).deletion.warnings).toEqual(["ONPREM_MANUAL_CLEANUP"]);
  });

  it("진행 중인 배포가 있으면 409 · 상태를 바꾸지 않는다", async () => {
    const id = await project();
    await deployment(id, "awaiting_target_confirmation");

    await expect(projects.requestDeletion(id)).rejects.toMatchObject({
      statusCode: 409,
      code: "PROJECT_DEPLOYMENT_IN_PROGRESS",
    });
    expect((await projects.get(id)).deletion).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("삭제 중인 앱에는 새 배포를 만들지 않는다", async () => {
    const id = await project();
    await projects.requestDeletion(id);
    const deployments = new DeploymentService(
      pool,
      { send: vi.fn() } as unknown as PgBoss,
      { put: vi.fn() } as unknown as Storage,
    );

    await expect(
      deployments.create({ projectId: id, targetVendor: "aws", fileBuffer: Buffer.from("zip") }),
    ).rejects.toMatchObject({ statusCode: 409, code: "PROJECT_DELETING" });
  });
});
