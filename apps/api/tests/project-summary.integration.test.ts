/**
 * apps/api/tests/project-summary.integration.test.ts
 * GET /projects 의 live · latest, GET /projects/:id/deployments 의 환경 · isLive 를 실제 PostgreSQL 로 확인한다.
 * PROJECT_TEST_DATABASE_URL 이 없으면 건너뜀. 예: postgres://postgres:postgres@localhost:5436/postgres
 */

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "@camellia/db";
import { ProjectService } from "../src/services/project-service.js";

const databaseUrl = process.env["PROJECT_TEST_DATABASE_URL"];
const schema = `project_test_${randomUUID().replaceAll("-", "")}`;
const migrations = new URL("../../../packages/db/migrations/", import.meta.url);
let admin: Pool;
let pool: Pool;
let svc: ProjectService;

async function insertProject(name: string): Promise<number> {
  const res = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ($1) RETURNING id`, [name]);
  return Number(res.rows[0]!.id);
}

async function insertEnvironment(projectId: number, name: string, type: "aws" | "onprem"): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO environments (project_id, name, type) VALUES ($1, $2, $3) RETURNING id`,
    [projectId, name, type],
  );
  return Number(res.rows[0]!.id);
}

async function insertDeployment(
  projectId: number,
  status: string,
  environmentId: number | null,
  times: { createdAt: string; succeededAt?: string },
): Promise<number> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO deployments (project_id, status, target_environment_id, created_at, succeeded_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [projectId, status, environmentId, times.createdAt, times.succeededAt ?? null],
  );
  return Number(res.rows[0]!.id);
}

describe.skipIf(!databaseUrl)("프로젝트 요약 · 배포 이력: 실제 PostgreSQL", () => {
  let appA: number;
  let appB: number;
  let appC: number;
  let awsEnv: number;
  let onpremEnv: number;
  let firstSucceeded: number;
  let onpremSucceeded: number;
  let building: number;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    for (const file of (await readdir(migrations)).filter((f) => f.endsWith(".sql")).sort()) {
      await pool.query(await readFile(new URL(file, migrations), "utf8"));
    }
    svc = new ProjectService(pool, "camellia-deploy.app");

    // appA: AWS 성공 → 온프레미스 성공 → 실패 → 빌드 중. live = 온프레미스 성공, latest = 빌드 중
    appA = await insertProject("app-a");
    awsEnv = await insertEnvironment(appA, "prod-aws", "aws");
    onpremEnv = await insertEnvironment(appA, "home-mac", "onprem");
    firstSucceeded = await insertDeployment(appA, "succeeded", awsEnv, {
      createdAt: "2026-09-30T01:00:00Z", succeededAt: "2026-09-30T01:05:00Z",
    });
    onpremSucceeded = await insertDeployment(appA, "succeeded", onpremEnv, {
      createdAt: "2026-09-30T02:00:00Z", succeededAt: "2026-09-30T02:05:00Z",
    });
    await insertDeployment(appA, "failed", awsEnv, { createdAt: "2026-09-30T03:00:00Z" });
    building = await insertDeployment(appA, "building", awsEnv, { createdAt: "2026-09-30T04:00:00Z" });

    // appB: 실패만 있음 (환경 없는 옛 배포). live = null, latest = 실패
    appB = await insertProject("app-b");
    await insertDeployment(appB, "failed", null, { createdAt: "2026-09-30T01:00:00Z" });

    // appC: 배포 없음
    appC = await insertProject("app-c");
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it("GET /projects — 프로젝트마다 live · latest 를 함께 반환함", async () => {
    const list = await svc.list({ limit: 20 });

    expect(list.items.map((p) => p.id)).toEqual([String(appA), String(appB), String(appC)]);
    const [a, b, c] = list.items;
    expect(a!.live).toEqual({
      deploymentId: String(onpremSucceeded),
      environmentId: String(onpremEnv),
      environmentType: "onprem",
      environmentName: "home-mac",
      targetProfile: null,
      publicUrl: `https://service-${appA}.camellia-deploy.app`,
      succeededAt: "2026-09-30T02:05:00.000Z",
    });
    // 배포 형태를 고른 적 없는 앱은 컨테이너 (#282)
    expect(a!.deployMode).toBe("container");
    expect(a!.latest).toEqual({
      deploymentId: String(building),
      status: "building",
      environmentType: "aws",
      createdAt: "2026-09-30T04:00:00.000Z",
    });
    expect(b!.live).toBeNull();
    expect(b!.latest).toMatchObject({ status: "failed", environmentType: null });
    expect(c!.live).toBeNull();
    expect(c!.latest).toBeNull();
  });

  it("GET /projects — cursor 페이지네이션은 그대로임", async () => {
    const first = await svc.list({ limit: 2 });
    expect(first.items.map((p) => p.id)).toEqual([String(appA), String(appB)]);
    expect(first.nextCursor).toBe(String(appB));

    const second = await svc.list({ limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((p) => p.id)).toEqual([String(appC)]);
    expect(second.nextCursor).toBeNull();
  });

  it("GET /projects/:id — live · latest 포함", async () => {
    const a = await svc.get(appA);
    expect(a.live?.deploymentId).toBe(String(onpremSucceeded));
    expect(a.latest?.deploymentId).toBe(String(building));
  });

  it("GET /projects/:id/deployments — 환경 정보와 isLive (live 배포 하나만 true)", async () => {
    const list = await svc.listDeployments(appA, { limit: 20 });

    const live = list.items.filter((d) => d.isLive).map((d) => d.id);
    expect(live).toEqual([String(onpremSucceeded)]);
    const first = list.items.find((d) => d.id === String(firstSucceeded))!;
    expect(first).toMatchObject({
      status: "succeeded",
      environmentId: String(awsEnv),
      environmentType: "aws",
      environmentName: "prod-aws",
      isLive: false,
    });

    // 페이지를 나눠도, 상태 필터를 걸어도 같은 배포만 live
    const page = await svc.listDeployments(appA, { limit: 1, cursor: building });
    expect(page.items.map((d) => [d.id, d.isLive])).toEqual([[String(building - 1), false]]);
    const succeededOnly = await svc.listDeployments(appA, { limit: 20, status: "succeeded" });
    expect(succeededOnly.items.map((d) => [d.id, d.isLive])).toEqual([
      [String(onpremSucceeded), true],
      [String(firstSucceeded), false],
    ]);
  });

  it("GET /projects/:id/deployments — 환경 없는 배포는 환경 필드 null", async () => {
    const list = await svc.listDeployments(appB, { limit: 20 });
    expect(list.items[0]).toMatchObject({
      environmentId: null,
      environmentType: null,
      environmentName: null,
      isLive: false,
    });
  });
});
