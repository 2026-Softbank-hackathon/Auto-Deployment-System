/**
 * apps/api/tests/project-subdomain.test.ts
 * 사용자 지정 앱 주소 (#300) — 프로젝트 생성 · 주소 확인 · 응답 publicUrl 이 프로젝트 subdomain 을 쓴다.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import {
  DeploymentSchema,
  ErrorBodySchema,
  ProjectDeploymentListSchema,
  ProjectSchema,
  SubdomainAvailabilitySchema,
} from "@camellia/contracts";
import { buildServer } from "../src/server.js";
import { MockPgBoss, MockPool, MockStorage } from "./mocks/db.js";

const NOW = new Date("2026-10-02T03:00:00.000Z");
let server: FastifyInstance;
let pool: MockPool;
let queries: Array<{ sql: string; params: unknown[] }>;

function projectRow(id: number, subdomain: string | null) {
  return {
    id, name: `app-${id}`, description: null, created_at: NOW, updated_at: NOW,
    deploy_mode: "container", subdomain,
  };
}

beforeEach(async () => {
  pool = new MockPool();
  queries = [];
  const query = pool.query.bind(pool);
  pool.query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
    return query(sql, params);
  };
  server = await buildServer({
    pool: pool as unknown as Pool,
    boss: new MockPgBoss() as unknown as PgBoss,
    storage: new MockStorage() as unknown as Storage,
    nodeEnv: "development",
    logger: false,
    enablePgListener: false,
    platformDomain: "camellia-deploy.app",
  });
  await server.ready();
});

afterEach(async () => {
  await server.close();
});

describe("POST /projects — 앱 주소 (#300)", () => {
  it("고른 주소를 소문자로 저장하고 응답에 subdomain · publicUrl 을 준다", async () => {
    pool.on(/INSERT INTO projects/, (params) => ({ rows: [projectRow(5, params[2] as string)] }));

    const res = await server.inject({
      method: "POST", url: "/api/v1/projects", payload: { name: "monolith", subdomain: " Monolith-Seohyeon " },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      subdomain: "monolith-seohyeon",
      publicUrl: "https://monolith-seohyeon.camellia-deploy.app",
    });
    expect(ProjectSchema.safeParse(res.json()).success).toBe(true);
    const insert = queries.find((q) => q.sql.startsWith("INSERT INTO projects"));
    expect(insert?.params).toEqual(["monolith", null, "monolith-seohyeon"]);
    // 주소 사용 여부 확인과 저장이 겹치지 않도록 잠근다
    expect(queries.some((q) => /pg_advisory_xact_lock/.test(q.sql))).toBe(true);
  });

  it("주소를 고르지 않으면 service-{id} (DB 트리거가 채움)", async () => {
    pool.on(/INSERT INTO projects/, () => ({ rows: [projectRow(6, "service-6")] }));

    const res = await server.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "plain" } });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ subdomain: "service-6", publicUrl: "https://service-6.camellia-deploy.app" });
  });

  it("다른 앱이 쓰는 주소면 409 SUBDOMAIN_TAKEN", async () => {
    pool.on(/FROM projects WHERE lower\(subdomain\)/, () => ({ rows: [{ id: 1 }] }));
    pool.on(/INSERT INTO projects/, () => ({ rows: [projectRow(7, "shop")] }));

    const res = await server.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "x", subdomain: "shop" } });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SUBDOMAIN_TAKEN");
    expect(ErrorBodySchema.safeParse(res.json()).success).toBe(true);
    expect(queries.some((q) => q.sql.startsWith("INSERT INTO projects"))).toBe(false);
  });

  it("동시에 같은 주소로 만들어 유일 인덱스에 걸려도 409 SUBDOMAIN_TAKEN", async () => {
    pool.on(/INSERT INTO projects/, () => {
      throw Object.assign(new Error("duplicate"), { code: "23505", constraint: "projects_subdomain_unique" });
    });

    const res = await server.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "x", subdomain: "shop" } });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("SUBDOMAIN_TAKEN");
  });

  it("형식 오류 · 예약어는 400", async () => {
    for (const subdomain of ["ab", "-shop", "shop_1", "console", "verify-d3", "service-12"]) {
      const res = await server.inject({ method: "POST", url: "/api/v1/projects", payload: { name: "x", subdomain } });
      expect(res.statusCode, subdomain).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("GET /projects/subdomain-availability (#300)", () => {
  async function check(name: string) {
    const res = await server.inject({
      method: "GET", url: `/api/v1/projects/subdomain-availability?name=${encodeURIComponent(name)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(SubdomainAvailabilitySchema.safeParse(res.json()).success).toBe(true);
    return res.json();
  }

  it("쓸 수 있는 주소", async () => {
    expect(await check(" Shop ")).toEqual({ name: "shop", available: true, reason: null });
  });

  it("다른 앱이 쓰는 주소는 taken", async () => {
    pool.on(/FROM projects WHERE lower\(subdomain\)/, (params) => ({ rows: params[0] === "shop" ? [{ id: 1 }] : [] }));
    expect(await check("shop")).toEqual({ name: "shop", available: false, reason: "taken" });
  });

  it("형식 오류 · 예약어는 DB 를 보지 않고 답한다", async () => {
    expect(await check("a_b")).toEqual({ name: "a_b", available: false, reason: "format" });
    expect(await check("www")).toEqual({ name: "www", available: false, reason: "reserved" });
    expect(queries.some((q) => /lower\(subdomain\)/.test(q.sql))).toBe(false);
  });
});

describe("응답 publicUrl 이 프로젝트 주소를 쓴다 (#300)", () => {
  it("GET /projects/:id — subdomain · publicUrl · live.publicUrl", async () => {
    pool.on(/FROM projects p/, () => ({
      rows: [{
        ...projectRow(3, "shop"),
        live_deployment_id: "9", live_environment_id: "2", live_environment_type: "aws",
        live_environment_name: "prod", live_target_profile: "aws-ecs-basic", live_succeeded_at: NOW,
        latest_deployment_id: "9", latest_status: "succeeded", latest_environment_type: "aws", latest_created_at: NOW,
        deletion_status: null, deletion_error: null, deletion_requested_at: null, deletion_warnings: [],
      }],
    }));

    const res = await server.inject({ method: "GET", url: "/api/v1/projects/3" });

    expect(res.json()).toMatchObject({
      subdomain: "shop",
      publicUrl: "https://shop.camellia-deploy.app",
      live: { publicUrl: "https://shop.camellia-deploy.app" },
    });
    expect(ProjectSchema.safeParse(res.json()).success).toBe(true);
  });

  it("subdomain 이 비어 있는 예전 row 는 service-{id}", async () => {
    pool.on(/FROM projects p/, () => ({
      rows: [{
        ...projectRow(4, null),
        live_deployment_id: null, live_environment_id: null, live_environment_type: null,
        live_environment_name: null, live_target_profile: null, live_succeeded_at: null,
        latest_deployment_id: null, latest_status: null, latest_environment_type: null, latest_created_at: null,
        deletion_status: null, deletion_error: null, deletion_requested_at: null, deletion_warnings: [],
      }],
    }));

    const res = await server.inject({ method: "GET", url: "/api/v1/projects/4" });

    expect(res.json()).toMatchObject({ subdomain: "service-4", publicUrl: "https://service-4.camellia-deploy.app" });
  });

  it("GET /deployments/:id", async () => {
    pool.on(/FROM deployments WHERE id = \$1/, () => ({
      rows: [{
        id: 42, project_id: 3, project_subdomain: "shop", status: "succeeded", target_profile: "aws-ecs-basic",
        target_environment_id: 2, registry_environment_id: 2, public_url: "http://alb.example",
        created_at: NOW, updated_at: NOW, succeeded_at: NOW, failed_at: null, error: null,
      }],
    }));

    const res = await server.inject({ method: "GET", url: "/api/v1/deployments/42" });

    expect(res.json().publicUrl).toBe("https://shop.camellia-deploy.app");
    expect(DeploymentSchema.safeParse(res.json()).success).toBe(true);
  });

  it("GET /projects/:id/deployments", async () => {
    pool.on(/FROM projects WHERE id = \$1/, () => ({ rows: [{ subdomain: "shop" }] }));
    pool.on(/FROM deployments d/, () => ({
      rows: [{
        id: 42, project_id: 3, status: "succeeded", target_profile: "aws-ecs-basic", public_url: null,
        created_at: NOW, succeeded_at: NOW, failed_at: null, source_version_id: null, source_sha256: null,
        environment_id: null, environment_type: null, environment_name: null, is_live: true,
      }],
    }));

    const res = await server.inject({ method: "GET", url: "/api/v1/projects/3/deployments" });

    expect(res.json().items[0].publicUrl).toBe("https://shop.camellia-deploy.app");
    expect(ProjectDeploymentListSchema.safeParse(res.json()).success).toBe(true);
  });
});
