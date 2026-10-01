/**
 * API-01 세션 인증 발급 · Bearer 세션 토큰으로 API 호출
 */

import { describe, it, expect, afterEach } from "vitest";
import { SessionResponseSchema } from "@camellia/contracts";
import { buildServer } from "../src/server.js";
import { MockPool, MockPgBoss, MockStorage } from "./mocks/db.js";
import type { FastifyInstance } from "fastify";

describe("API-01 POST /auth/session", () => {
  let server: FastifyInstance;

  afterEach(async () => {
    if (server) await server.close();
  });

  it("유효한 apiKey → 201 + 계약 스키마, 세션 토큰으로 보호 API 호출", async () => {
    server = await buildServer({
      pool: new MockPool() as never,
      boss: new MockPgBoss() as never,
      storage: new MockStorage() as never,
      apiKey: "test-api-key",
      nodeEnv: "production",
      enablePgListener: false,
      logger: false,
      secretMasterKey: Buffer.alloc(32, 1),
    });

    const bad = await server.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { apiKey: "wrong" },
    });
    expect(bad.statusCode).toBe(401);

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { apiKey: "test-api-key" },
    });
    expect(res.statusCode).toBe(201);
    const session = SessionResponseSchema.parse(res.json());
    expect(session.token).toBeTruthy();
    expect(session.userId).toMatch(/^usr_/);

    const projects = await server.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(projects.statusCode).toBe(200);
  });

  it("API_KEY 미설정 시 세션 발급 503", async () => {
    server = await buildServer({
      pool: new MockPool() as never,
      boss: new MockPgBoss() as never,
      storage: new MockStorage() as never,
      nodeEnv: "development",
      enablePgListener: false,
      logger: false,
    });

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/auth/session",
      payload: { apiKey: "any" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("MISCONFIGURED");
  });
});
