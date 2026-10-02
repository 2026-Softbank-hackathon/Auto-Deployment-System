/**
 * apps/api/tests/project-deployments.test.ts
 * GET /api/v1/projects/:id/deployments (LOG-01 / API-22) 라우트 테스트.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import { buildServer } from "../src/server.js";
import { MockPgBoss, MockPool, MockStorage } from "./mocks/db.js";

let server: FastifyInstance;
let pool: MockPool;

beforeEach(async () => {
  pool = new MockPool();
  server = await buildServer({
    pool: pool as unknown as Pool,
    boss: new MockPgBoss() as unknown as PgBoss,
    storage: new MockStorage() as unknown as Storage,
    nodeEnv: "development",
    logger: false,
    enablePgListener: false,
  });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  pool.reset();
});

function deploymentRow(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    project_id: 1,
    status: "succeeded",
    target_profile: "aws-ecs-basic",
    public_url: `https://app-${id}.example.com`,
    created_at: new Date(`2026-09-30T0${id}:00:00.000Z`),
    succeeded_at: new Date(`2026-09-30T0${id}:05:00.000Z`),
    failed_at: null,
    source_version_id: id * 10,
    source_sha256: `sha-${id}`,
    environment_id: "5",
    environment_type: "aws",
    environment_name: "prod-aws",
    is_live: false,
    ...overrides,
  };
}

/** 프로젝트 1개 + 배포 rows. 배포 쿼리 params = [projectId, status, cursor, limit]. */
function givenProject(rows: ReturnType<typeof deploymentRow>[]) {
  pool.on(/FROM projects WHERE id/, () => ({ rows: [{ id: 1 }] }));
  pool.on(/FROM deployments/, (params) => {
    const [, status, cursor, limit] = params as [number, string | null, number | null, number];
    const filtered = rows
      .filter((r) => status === null || r.status === status)
      .filter((r) => cursor === null || r.id < cursor)
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
    return { rows: filtered };
  });
}

describe("GET /api/v1/projects/:id/deployments", () => {
  it("프로젝트가 없으면 404", async () => {
    pool.on(/FROM projects WHERE id/, () => ({ rows: [] }));

    const res = await server.inject({ method: "GET", url: "/api/v1/projects/99/deployments" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("최신 배포부터 이력을 반환함", async () => {
    givenProject([
      deploymentRow(1, { is_live: true }),
      deploymentRow(2, {
        status: "failed",
        public_url: null,
        succeeded_at: null,
        failed_at: new Date("2026-09-30T02:03:00.000Z"),
        environment_id: "6",
        environment_type: "onprem",
        environment_name: "home-mac",
      }),
    ]);

    const res = await server.inject({ method: "GET", url: "/api/v1/projects/1/deployments" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          id: "2",
          status: "failed",
          targetProfile: "aws-ecs-basic",
          publicUrl: null,
          sourceVersion: { id: "20", sha256: "sha-2" },
          createdAt: "2026-09-30T02:00:00.000Z",
          succeededAt: null,
          failedAt: "2026-09-30T02:03:00.000Z",
          environmentId: "6",
          environmentType: "onprem",
          environmentName: "home-mac",
          isLive: false,
        },
        {
          id: "1",
          status: "succeeded",
          targetProfile: "aws-ecs-basic",
          publicUrl: null,
          sourceVersion: { id: "10", sha256: "sha-1" },
          createdAt: "2026-09-30T01:00:00.000Z",
          succeededAt: "2026-09-30T01:05:00.000Z",
          failedAt: null,
          environmentId: "5",
          environmentType: "aws",
          environmentName: "prod-aws",
          isLive: true,
        },
      ],
      nextCursor: null,
    });
  });

  it("환경 없이 만든 옛 배포는 환경 필드 null", async () => {
    givenProject([
      deploymentRow(1, { environment_id: null, environment_type: null, environment_name: null }),
    ]);

    const res = await server.inject({ method: "GET", url: "/api/v1/projects/1/deployments" });

    expect(res.json().items[0]).toMatchObject({
      environmentId: null,
      environmentType: null,
      environmentName: null,
      isLive: false,
    });
  });

  it("소스 버전이 없는 배포는 sourceVersion null", async () => {
    givenProject([deploymentRow(1, { source_version_id: null, source_sha256: null })]);

    const res = await server.inject({ method: "GET", url: "/api/v1/projects/1/deployments" });

    expect(res.json().items[0].sourceVersion).toBeNull();
  });

  it("limit을 넘으면 nextCursor로 다음 페이지를 이어 조회함", async () => {
    givenProject([deploymentRow(1), deploymentRow(2), deploymentRow(3)]);

    const first = await server.inject({ method: "GET", url: "/api/v1/projects/1/deployments?limit=2" });
    expect(first.json().items.map((d: { id: string }) => d.id)).toEqual(["3", "2"]);
    expect(first.json().nextCursor).toBe("2");

    const second = await server.inject({
      method: "GET",
      url: "/api/v1/projects/1/deployments?limit=2&cursor=2",
    });
    expect(second.json().items.map((d: { id: string }) => d.id)).toEqual(["1"]);
    expect(second.json().nextCursor).toBeNull();
  });

  it("status로 대기열(queued)만 조회함", async () => {
    givenProject([
      deploymentRow(1),
      deploymentRow(2, { status: "queued", succeeded_at: null }),
    ]);

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/projects/1/deployments?status=queued",
    });

    expect(res.json().items.map((d: { id: string }) => d.id)).toEqual(["2"]);
  });

  it("cursor가 숫자가 아니면 400", async () => {
    givenProject([]);

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/projects/1/deployments?cursor=abc",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/v1/projects/:id/deployments — platformDomain 주입 시 publicUrl 재계산", () => {
  let serverWithDomain: FastifyInstance;
  let poolWithDomain: MockPool;

  beforeEach(async () => {
    poolWithDomain = new MockPool();
    serverWithDomain = await buildServer({
      pool: poolWithDomain as unknown as Pool,
      boss: new MockPgBoss() as unknown as PgBoss,
      storage: new MockStorage() as unknown as Storage,
      nodeEnv: "development",
      logger: false,
      enablePgListener: false,
      platformDomain: "camellia-deploy.app",
    });
    await serverWithDomain.ready();
  });

  afterEach(async () => {
    await serverWithDomain.close();
    poolWithDomain.reset();
  });

  it("platformDomain 주입 시 publicUrl 을 service-{projectId}.{domain} 포맷으로 반환함", async () => {
    poolWithDomain.on(/FROM projects WHERE id/, () => ({ rows: [{ id: 1 }] }));
    poolWithDomain.on(/FROM deployments/, () => ({
      rows: [deploymentRow(1)],
    }));

    const res = await serverWithDomain.inject({
      method: "GET",
      url: "/api/v1/projects/1/deployments",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items[0].publicUrl).toBe("https://service-1.camellia-deploy.app");
  });
});
