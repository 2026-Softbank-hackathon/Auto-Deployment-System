/**
 * apps/api/tests/auth.test.ts — production 인증 misconfiguration 방어
 */

import { describe, it, expect, afterEach } from "vitest";
import { buildServer } from "../src/server.js";
import { MockPool, MockPgBoss, MockStorage } from "./mocks/db.js";
import type { FastifyInstance } from "fastify";

describe("auth plugin", () => {
  let server: FastifyInstance;

  afterEach(async () => {
    if (server) await server.close();
  });

  it("production 에서 API_KEY 미설정 시 API 호출 503 MISCONFIGURED", async () => {
    server = await buildServer({
      pool: new MockPool() as never,
      boss: new MockPgBoss() as never,
      storage: new MockStorage() as never,
      nodeEnv: "production",
      enablePgListener: false,
      logger: false,
    });

    const res = await server.inject({ method: "GET", url: "/api/v1/projects" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("MISCONFIGURED");
  });
});
