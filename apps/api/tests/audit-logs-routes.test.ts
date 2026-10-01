/**
 * apps/api/tests/audit-logs-routes.test.ts
 * GET /api/v1/audit-logs 조회 API 테스트 (fastify.inject + MockPool).
 *
 * - 기본 조회 → 200 + items 배열
 * - actor 필터 파싱 ("session:abc")
 * - resource 필터 파싱 ("deployment:42")
 * - limit 파라미터
 * - nextCursor 존재 확인
 * - 빈 결과 → items: [], nextCursor: null
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { MockPool, MockPgBoss, MockStorage } from "./mocks/db.js";

let server: FastifyInstance;
let pool: MockPool;
let boss: MockPgBoss;
let storage: MockStorage;

const SAMPLE_ROW = {
  id: "10",
  actor_type: "session",
  actor_id: "abc123…",
  action: "POST /deployments",
  resource_type: "deployment",
  resource_id: "42",
  status_code: 201,
  request_id: "req_abc",
  metadata: { name: "my-app" },
  created_at: new Date("2026-10-01T00:00:00.000Z"),
};

beforeEach(async () => {
  pool = new MockPool();
  boss = new MockPgBoss();
  storage = new MockStorage();
  server = await buildServer({
    pool: pool as any,
    boss: boss as any,
    storage: storage as any,
    nodeEnv: "test",
    logger: false,
    enablePgListener: false,
  });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  pool.reset();
  boss.reset();
  storage.reset();
});

describe("GET /api/v1/audit-logs", () => {
  it("기본 조회 → 200 + items 배열", async () => {
    pool.on(/SELECT.*FROM audit_logs/i, () => ({ rows: [SAMPLE_ROW] }));

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/audit-logs",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("10");
    expect(body.items[0].actorType).toBe("session");
    expect(body.items[0].action).toBe("POST /deployments");
    expect(body.nextCursor).toBeNull();
  });

  it("빈 결과 → items: [], nextCursor: null", async () => {
    pool.on(/SELECT.*FROM audit_logs/i, () => ({ rows: [] }));

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/audit-logs",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(0);
    expect(body.nextCursor).toBeNull();
  });

  it("limit 파라미터 — limit=2 에 행 3개 있으면 nextCursor 반환", async () => {
    const rows = [
      { ...SAMPLE_ROW, id: "10" },
      { ...SAMPLE_ROW, id: "9" },
      { ...SAMPLE_ROW, id: "8" }, // limit+1 번째
    ];
    pool.on(/SELECT.*FROM audit_logs/i, () => ({ rows }));

    const res = await server.inject({
      method: "GET",
      url: "/api/v1/audit-logs?limit=2",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).not.toBeNull();
    // nextCursor 디코딩 시 "9" 여야 함
    const decoded = Buffer.from(body.nextCursor, "base64url").toString("utf8");
    expect(decoded).toBe("9");
  });

  it("actor 필터 파싱 — session:abc → SQL 에 actor_type, actor_id 반영", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];
    pool.on(/FROM audit_logs/i, (params) => {
      // params가 여기서 전달되지 않으므로 SQL 캡처는 pool.query wrap으로 처리
      capturedParams = params;
      return { rows: [] };
    });

    // MockPool.query 는 prototype method → prototype 에 spy 등록
    const origQuery = pool.query.bind(pool);
    Object.defineProperty(pool, "query", {
      value: async (sql: string, params: unknown[] = []) => {
        if (/FROM audit_logs/i.test(sql)) {
          capturedSql = sql;
          capturedParams = params;
          return { rows: [] };
        }
        return origQuery(sql, params);
      },
      writable: true,
      configurable: true,
    });

    await server.inject({
      method: "GET",
      url: "/api/v1/audit-logs?actor=session:abc",
    });

    expect(capturedSql).toMatch(/actor_type = \$/);
    expect(capturedSql).toMatch(/actor_id = \$/);
    expect(capturedParams).toContain("session");
    expect(capturedParams).toContain("abc");
  });

  it("resource 필터 파싱 — deployment:42 → SQL 에 resource_type, resource_id 반영", async () => {
    let capturedSql = "";
    let capturedParams: unknown[] = [];

    const origQuery = pool.query.bind(pool);
    Object.defineProperty(pool, "query", {
      value: async (sql: string, params: unknown[] = []) => {
        if (/FROM audit_logs/i.test(sql)) {
          capturedSql = sql;
          capturedParams = params;
          return { rows: [] };
        }
        return origQuery(sql, params);
      },
      writable: true,
      configurable: true,
    });

    await server.inject({
      method: "GET",
      url: "/api/v1/audit-logs?resource=deployment:42",
    });

    expect(capturedSql).toMatch(/resource_type = \$/);
    expect(capturedSql).toMatch(/resource_id = \$/);
    expect(capturedParams).toContain("deployment");
    expect(capturedParams).toContain("42");
  });

  it("cursor 파라미터 전달 시 SQL 에 id < $N 포함", async () => {
    const cursor = Buffer.from("50", "utf8").toString("base64url");
    let capturedSql = "";

    const origQuery = pool.query.bind(pool);
    Object.defineProperty(pool, "query", {
      value: async (sql: string, params: unknown[] = []) => {
        if (/FROM audit_logs/i.test(sql)) {
          capturedSql = sql;
          return { rows: [] };
        }
        return origQuery(sql, params);
      },
      writable: true,
      configurable: true,
    });

    await server.inject({
      method: "GET",
      url: `/api/v1/audit-logs?cursor=${cursor}`,
    });

    expect(capturedSql).toMatch(/id < \$/);
  });
});
