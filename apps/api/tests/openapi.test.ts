/**
 * apps/api/tests/openapi.test.ts
 * UI-01 OpenAPI 문서 · Swagger UI.
 * Fastify에 실제 등록된 /api/v1 라우트가 모두 문서에 태그 · 요약과 함께 나오는지,
 * 문서용 schema가 기존 Zod 검증 동작을 바꾸지 않는지 확인한다.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import { buildServer } from "../src/server.js";
import { MockPgBoss, MockPool, MockStorage } from "./mocks/db.js";

interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  requestBody?: { content: Record<string, { schema: { properties?: Record<string, unknown> } }> };
}

interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Record<string, OpenApiOperation>>;
}

let server: FastifyInstance;

async function start(opts: { nodeEnv?: string; apiKey?: string } = {}) {
  server = await buildServer({
    pool: new MockPool() as unknown as Pool,
    boss: new MockPgBoss() as unknown as PgBoss,
    storage: new MockStorage() as unknown as Storage,
    nodeEnv: opts.nodeEnv ?? "development",
    apiKey: opts.apiKey,
    logger: false,
    enablePgListener: false,
  });
  await server.ready();
}

/**
 * Fastify에 실제 등록된 라우트 목록. printRoutes 트리를 펼친다.
 *   ├── /api/v1/projects (POST, GET, HEAD)
 *   │   └── / (POST, GET, HEAD)
 *   │       └── :id (GET, HEAD)
 */
function registeredRoutes() {
  const routes: Array<{ method: string; url: string }> = [];
  const stack: string[] = [];
  for (const line of server.printRoutes({ commonPrefix: false }).split("\n")) {
    const m = /^(.*?)[└├]── (.+?)(?: \(([A-Z, ]+)\))?$/.exec(line);
    if (!m) continue;
    const depth = m[1]!.length / 4;
    stack.length = depth;
    const url = (stack[depth - 1] ?? "") + m[2];
    stack.push(url);
    for (const method of m[3]?.split(", ") ?? []) routes.push({ method, url });
  }
  return routes;
}

async function getDocument(): Promise<OpenApiDocument> {
  const res = await server.inject({ method: "GET", url: "/docs/json" });
  expect(res.statusCode).toBe(200);
  return res.json() as OpenApiDocument;
}

/** Fastify 경로(`/a/:id/`) → OpenAPI 경로(`/a/{id}`) */
function toOpenApiPath(url: string) {
  const path = url.replace(/:(\w+)/g, "{$1}");
  return path.length > 1 ? path.replace(/\/$/, "") : path;
}

afterEach(async () => {
  await server.close();
});

describe("GET /docs/json", () => {
  it("OpenAPI 3 문서를 반환함", async () => {
    await start();

    const doc = await getDocument();

    expect(doc.openapi).toMatch(/^3\./);
    expect(Object.keys(doc.paths).length).toBeGreaterThan(0);
  });

  it("등록된 /api/v1 라우트가 모두 태그 · 요약과 함께 문서에 있음", async () => {
    await start();
    const doc = await getDocument();

    const apiRoutes = registeredRoutes().filter((r) => r.url.startsWith("/api/v1/") && r.method !== "HEAD");
    expect(apiRoutes.length).toBeGreaterThanOrEqual(20);

    for (const { method, url } of apiRoutes) {
      const op = doc.paths[toOpenApiPath(url)]?.[method.toLowerCase()];
      expect(op, `${method} ${url} 문서 누락`).toBeDefined();
      expect((op?.tags ?? []).length, `${method} ${url} 태그 누락`).toBeGreaterThan(0);
      expect(op?.summary, `${method} ${url} 요약 누락`).toBeTruthy();
    }
  });

  it("PATCH /projects/{id}/env 는 path id 와 바디 vars 를 문서화함", async () => {
    await start();
    const doc = await getDocument();

    const op = doc.paths["/api/v1/projects/{id}/env"]?.patch;
    expect(op?.parameters).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "id", in: "path", required: true })]),
    );
    expect(op?.requestBody?.content["application/json"]?.schema.properties).toHaveProperty("vars");
  });

  it("GET /projects/{id}/deployments 는 cursor · limit · status 쿼리를 문서화함", async () => {
    await start();
    const doc = await getDocument();

    const names = doc.paths["/api/v1/projects/{id}/deployments"]?.get?.parameters
      ?.filter((p) => p.in === "query")
      .map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["cursor", "limit", "status"]));
  });

  it("POST /deployments 는 multipart 업로드 필드를 문서화함", async () => {
    await start();
    const doc = await getDocument();

    const body = doc.paths["/api/v1/deployments"]?.post?.requestBody;
    const props = body?.content["multipart/form-data"]?.schema.properties;
    expect(Object.keys(props ?? {})).toEqual(expect.arrayContaining(["source", "project_id", "target"]));
  });
});

describe("GET /docs", () => {
  it("Swagger UI HTML 을 반환함", async () => {
    await start();

    const res = await server.inject({ method: "GET", url: "/docs" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("swagger-ui");
  });

  it("production 에서도 API Key 없이 문서를 열람하고, API 호출은 여전히 401", async () => {
    await start({ nodeEnv: "production", apiKey: "secret" });

    expect((await server.inject({ method: "GET", url: "/docs" })).statusCode).toBe(200);
    expect((await server.inject({ method: "GET", url: "/docs/json" })).statusCode).toBe(200);

    const api = await server.inject({ method: "GET", url: "/api/v1/projects" });
    expect(api.statusCode).toBe(401);
    expect(api.json().error.code).toBe("UNAUTHORIZED");
  });
});

describe("문서용 schema 는 검증 동작을 바꾸지 않음", () => {
  it("잘못된 바디는 기존대로 400 VALIDATION_ERROR (Zod 메시지)", async () => {
    await start();

    const res = await server.inject({
      method: "PATCH",
      url: "/api/v1/projects/1/env",
      payload: { vars: { "1BAD": "x" } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(res.json().error.message).toContain("환경변수 이름은");
  });

  it("잘못된 쿼리는 기존대로 Zod 경로가 포함된 400 VALIDATION_ERROR", async () => {
    await start();

    const res = await server.inject({ method: "GET", url: "/api/v1/projects?limit=0" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(res.json().error.message).toMatch(/^limit: /);
  });
});
