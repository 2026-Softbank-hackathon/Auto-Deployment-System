/**
 * apps/api/tests/agents-routes.test.ts
 * Agent 등록·인증·Heartbeat HTTP 라우트 테스트 (fastify.inject).
 *
 * - POST /environments/:id/agent-registration-token (세션 인증 필요)
 * - POST /agents/register (등록 토큰 소비)
 * - POST /agents/heartbeat (Bearer 토큰 인증)
 * - environment 없으면 404
 * - 이미 Agent 등록된 environment 재등록 시도 → 409
 * - 만료 토큰 → 400
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { MockPool, MockPgBoss, MockStorage } from "./mocks/db.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");

let server: FastifyInstance;
let pool: MockPool;
let boss: MockPgBoss;
let storage: MockStorage;

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

// ── POST /environments/:id/agent-registration-token ──────────────────────────

describe("POST /api/v1/environments/:id/agent-registration-token", () => {
  it("environment 존재 + dev bypass → 201 + token, expiresAt", async () => {
    pool.on(/FROM environments WHERE id/, () => ({ rows: [{ id: 1 }], rowCount: 1 }));
    pool.on(/INSERT INTO agent_registration_tokens/, () => ({ rows: [], rowCount: 1 }));

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/environments/1/agent-registration-token",
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBe(64);
    expect(typeof body.expiresAt).toBe("string");
  });

  it("environment 없으면 404", async () => {
    pool.on(/FROM environments/, () => ({ rows: [] }));

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/environments/999/agent-registration-token",
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("id 가 숫자 아니면 400", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/environments/abc/agent-registration-token",
    });

    expect(res.statusCode).toBe(400);
  });
});

// ── POST /agents/register ────────────────────────────────────────────────────

describe("POST /api/v1/agents/register", () => {
  it("유효 등록 토큰 → 201 + agentId, longLivedKey, environmentId", async () => {
    pool.on(/BEGIN|COMMIT|ROLLBACK/, () => ({ rows: [] }));
    pool.on(/FROM agent_registration_tokens/, () => ({
      rows: [{
        id: 1,
        environment_id: 10,
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    }));
    pool.on(/INSERT INTO agents/, () => ({
      rows: [{ id: 5, environment_id: 10 }],
    }));
    pool.on(/UPDATE agent_registration_tokens/, () => ({ rows: [] }));

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      payload: { registrationToken: "a".repeat(64) },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.agentId).toBe("5");
    expect(body.environmentId).toBe("10");
    expect(typeof body.longLivedKey).toBe("string");
  });

  it("유효하지 않은 토큰 → 400", async () => {
    pool.on(/BEGIN|COMMIT|ROLLBACK/, () => ({ rows: [] }));
    pool.on(/FROM agent_registration_tokens/, () => ({ rows: [] }));

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      payload: { registrationToken: "invalid-token" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("만료 토큰 → 400", async () => {
    pool.on(/BEGIN|COMMIT|ROLLBACK/, () => ({ rows: [] }));
    pool.on(/FROM agent_registration_tokens/, () => ({
      rows: [{
        id: 1,
        environment_id: 10,
        expires_at: new Date(Date.now() - 1000), // 만료
        consumed_at: null,
      }],
    }));

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      payload: { registrationToken: "a".repeat(64) },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("이미 Agent 등록된 environment 재등록 → 409", async () => {
    pool.on(/BEGIN|COMMIT|ROLLBACK/, () => ({ rows: [] }));
    pool.on(/FROM agent_registration_tokens/, () => ({
      rows: [{
        id: 1,
        environment_id: 10,
        expires_at: new Date(Date.now() + 60_000),
        consumed_at: null,
      }],
    }));
    pool.on(/INSERT INTO agents/, () => {
      throw new Error("unique constraint violation");
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      payload: { registrationToken: "a".repeat(64) },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe("CONFLICT");
  });

  it("body 없으면 400", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/agents/register",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });
});

// ── POST /agents/heartbeat ────────────────────────────────────────────────────

describe("POST /api/v1/agents/heartbeat", () => {
  const LONG_LIVED_KEY = "test-long-lived-key";

  it("유효 Bearer 토큰 → 200 { ok: true }", async () => {
    pool.on(/FROM agents WHERE long_lived_key_hash/, () => ({
      rows: [{ id: 3, environment_id: 7 }],
    }));
    pool.on(/UPDATE agents/, () => ({ rows: [] }));

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/agents/heartbeat",
      headers: { authorization: `Bearer ${LONG_LIVED_KEY}` },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.deploymentCancelled).toBeUndefined();
  });

  it("currentJobId 포함 + cancelled deployment → deploymentCancelled: true", async () => {
    pool.on(/FROM agents WHERE long_lived_key_hash/, () => ({
      rows: [{ id: 3, environment_id: 7 }],
    }));
    pool.on(/UPDATE agents/, () => ({ rows: [] }));
    pool.on(/FROM deployments/, () => ({
      rows: [{ status: "cancelled" }],
    }));

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/agents/heartbeat",
      headers: { authorization: `Bearer ${LONG_LIVED_KEY}` },
      payload: { currentJobId: "42" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.deploymentCancelled).toBe(true);
  });

  it("Authorization 헤더 없으면 401", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/agents/heartbeat",
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("잘못된 Bearer 토큰 → 401", async () => {
    pool.on(/FROM agents WHERE long_lived_key_hash/, () => ({ rows: [] }));

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/agents/heartbeat",
      headers: { authorization: "Bearer wrong-key" },
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
