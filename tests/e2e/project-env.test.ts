/**
 * tests/e2e/project-env.test.ts
 * EnvVarService (DAT-01) 실제 Postgres 통합 — UPSERT · 삭제 · 트랜잭션 · 프로젝트 격리.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, type Pool } from "@camellia/db";
import { EnvVarService } from "../../apps/api/src/services/env-var-service.js";

const describeWithPostgres =
  process.env["SKIP_E2E"] === "true" ? describe.skip : describe;

describeWithPostgres("프로젝트 환경변수 실제 Postgres 통합", () => {
  let pool: Pool;
  let svc: EnvVarService;
  const projectIds: number[] = [];

  async function newProject() {
    const res = await pool.query<{ id: string }>(
      `INSERT INTO projects(name) VALUES ($1) RETURNING id`,
      [`env-e2e-${crypto.randomUUID()}`],
    );
    const id = Number(res.rows[0]!.id);
    projectIds.push(id);
    return id;
  }

  const names = (r: { items: { name: string; value: string }[] }) =>
    r.items.map((v) => `${v.name}=${v.value}`);

  beforeAll(() => {
    pool = createPool(process.env["DATABASE_URL"]!);
    svc = new EnvVarService(pool);
  });

  afterAll(async () => {
    if (projectIds.length > 0) {
      await pool.query("DELETE FROM projects WHERE id = ANY($1::bigint[])", [projectIds]);
    }
    await pool?.end();
  });

  it("추가 · 덮어쓰기 · 삭제를 한 번에 반영하고 이름순으로 반환함", async () => {
    const projectId = await newProject();
    await svc.update(projectId, { NODE_ENV: "development", OLD_FLAG: "1", PORT: "3000" });

    const r = await svc.update(projectId, { NODE_ENV: "production", OLD_FLAG: null, LOG_LEVEL: "info" });

    expect(names(r)).toEqual(["LOG_LEVEL=info", "NODE_ENV=production", "PORT=3000"]);
    expect(names(await svc.list(projectId))).toEqual(names(r));
  });

  it("다른 프로젝트의 환경변수와 섞이지 않음", async () => {
    const a = await newProject();
    const b = await newProject();

    await svc.update(a, { NODE_ENV: "production" });
    await svc.update(b, { NODE_ENV: "staging" });

    expect(names(await svc.list(a))).toEqual(["NODE_ENV=production"]);
    expect(names(await svc.list(b))).toEqual(["NODE_ENV=staging"]);
  });

  it("없는 이름을 삭제해도 오류 없이 무시함", async () => {
    const projectId = await newProject();

    const r = await svc.update(projectId, { NOT_THERE: null });

    expect(r.items).toEqual([]);
  });

  it("프로젝트를 지우면 환경변수도 함께 지워짐", async () => {
    const projectId = await newProject();
    await svc.update(projectId, { NODE_ENV: "production" });

    await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);

    const left = await pool.query("SELECT 1 FROM env_vars WHERE project_id = $1", [projectId]);
    expect(left.rows).toHaveLength(0);
  });

  it("없는 프로젝트는 404", async () => {
    await expect(svc.list(2_147_483_647)).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.update(2_147_483_647, { A: "1" })).rejects.toMatchObject({ statusCode: 404 });
  });
});
