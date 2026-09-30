/**
 * apps/api/tests/project-env.test.ts
 * GET · PATCH /api/v1/projects/:id/env (DAT-01) 라우트 테스트 — 입력 검증 · 응답 형태.
 * UPSERT · 삭제 동작은 tests/e2e/project-env.test.ts 에서 실제 Postgres로 검증.
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

const ROWS = [
  { name: "LOG_LEVEL", value: "info", updated_at: new Date("2026-09-30T12:00:00.000Z") },
  { name: "NODE_ENV", value: "production", updated_at: new Date("2026-09-30T12:00:00.000Z") },
];

function givenProject() {
  pool.on(/FROM projects WHERE id/, () => ({ rows: [{ "?column?": 1 }] }));
  pool.on(/FROM env_vars/, () => ({ rows: ROWS }));
}

describe("GET /api/v1/projects/:id/env", () => {
  it("프로젝트 환경변수를 이름·값·수정 시각으로 반환함", async () => {
    givenProject();

    const res = await server.inject({ method: "GET", url: "/api/v1/projects/1/env" });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        { name: "LOG_LEVEL", value: "info", updatedAt: "2026-09-30T12:00:00.000Z" },
        { name: "NODE_ENV", value: "production", updatedAt: "2026-09-30T12:00:00.000Z" },
      ],
    });
  });

  it("프로젝트가 없으면 404", async () => {
    pool.on(/FROM projects WHERE id/, () => ({ rows: [] }));

    const res = await server.inject({ method: "GET", url: "/api/v1/projects/99/env" });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });
});

describe("PATCH /api/v1/projects/:id/env", () => {
  it("변경 후 전체 환경변수 목록을 반환함", async () => {
    givenProject();

    const res = await server.inject({
      method: "PATCH",
      url: "/api/v1/projects/1/env",
      payload: { vars: { NODE_ENV: "production", OLD_FLAG: null } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(2);
  });

  it("프로젝트가 없으면 404", async () => {
    pool.on(/FROM projects WHERE id/, () => ({ rows: [] }));

    const res = await server.inject({
      method: "PATCH",
      url: "/api/v1/projects/99/env",
      payload: { vars: { NODE_ENV: "production" } },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it.each([
    ["숫자로 시작하는 이름", { "1ABC": "x" }],
    ["하이픈이 들어간 이름", { "MY-VAR": "x" }],
    ["빈 변경", {}],
  ])("%s이면 400", async (_label, vars) => {
    givenProject();

    const res = await server.inject({
      method: "PATCH",
      url: "/api/v1/projects/1/env",
      payload: { vars },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });
});
