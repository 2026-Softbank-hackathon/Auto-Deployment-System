/**
 * tests/e2e/project-deployments.test.ts
 * ProjectService.listDeployments (LOG-01) 실제 Postgres 통합 — SQL 필터·정렬·커서 검증.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "@camellia/db";
import { ProjectService } from "../../apps/api/src/services/project-service.js";

const describeWithPostgres =
  process.env["SKIP_E2E"] === "true" ? describe.skip : describe;

describeWithPostgres("배포 이력 조회 실제 Postgres 통합", () => {
  let pool: Pool;
  let svc: ProjectService;
  let projectId: number;
  const ids: Record<"old" | "failed" | "queued", string> = { old: "", failed: "", queued: "" };

  async function insertDeployment(status: string) {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO deployments(project_id, status, target_profile)
       VALUES ($1, $2, 'aws-ecs-basic')
       RETURNING id`,
      [projectId, status],
    );
    return res.rows[0]!.id;
  }

  async function insertSource(deploymentId: string, sha256: string) {
    await pool.query(
      `INSERT INTO source_versions(deployment_id, sha256, storage_key, size_bytes)
       VALUES ($1, $2, $3, 1)`,
      [deploymentId, sha256, `sources/${sha256}.zip`],
    );
  }

  beforeAll(async () => {
    pool = createPool(process.env["DATABASE_URL"]!);
    svc = new ProjectService(pool);

    const project = await pool.query<{ id: string }>(
      `INSERT INTO projects(name) VALUES ($1) RETURNING id`,
      [`history-e2e-${crypto.randomUUID()}`],
    );
    projectId = Number(project.rows[0]!.id);

    ids.old = await insertDeployment("succeeded");
    await insertSource(ids.old, "sha-old-1");
    await insertSource(ids.old, "sha-old-2");
    ids.failed = await insertDeployment("failed");
    await insertSource(ids.failed, "sha-failed");
    ids.queued = await insertDeployment("queued");
  });

  afterAll(async () => {
    if (projectId) {
      await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
    }
    await pool?.end();
  });

  it("최신순으로 반환하고 소스 버전은 가장 최근 것을 붙임", async () => {
    const r = await svc.listDeployments(projectId, { limit: 20 });

    expect(r.items.map((d) => d.id)).toEqual([ids.queued, ids.failed, ids.old]);
    expect(r.items[0]?.sourceVersion).toBeNull();
    expect(r.items[2]?.sourceVersion?.sha256).toBe("sha-old-2");
    expect(r.nextCursor).toBeNull();
  });

  it("커서로 다음 페이지를 이어 조회함", async () => {
    const first = await svc.listDeployments(projectId, { limit: 2 });
    expect(first.items.map((d) => d.id)).toEqual([ids.queued, ids.failed]);
    expect(first.nextCursor).toBe(ids.failed);

    const second = await svc.listDeployments(projectId, {
      limit: 2,
      cursor: Number(first.nextCursor),
    });
    expect(second.items.map((d) => d.id)).toEqual([ids.old]);
    expect(second.nextCursor).toBeNull();
  });

  it("status 필터로 대기열만 조회함", async () => {
    const r = await svc.listDeployments(projectId, { limit: 20, status: "queued" });

    expect(r.items.map((d) => d.id)).toEqual([ids.queued]);
  });

  it("없는 프로젝트는 404", async () => {
    await expect(svc.listDeployments(2_147_483_647, { limit: 20 })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
