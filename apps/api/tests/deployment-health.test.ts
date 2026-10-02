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

describe("GET /api/v1/deployments/:id/health", () => {
  it("진행 중인 환경의 시도 목록과 연속 성공 횟수를 반환함", async () => {
    pool.on(/FROM deployments/, () => ({
      rows: [{ id: 42, status: "verifying", public_url: "https://example.com" }],
    }));
    pool.on(/FROM deployment_steps/, () => ({
      rows: [{
        id: 10,
        status: "running",
        step_name: "verify",
        message: JSON.stringify({ phase: "public_url", targetUrl: "https://service-42.example.com/health" }),
      }],
    }));
    pool.on(/FROM health_check_attempts/, () => ({
      rows: [
        {
          attempt: 1,
          checked_at: new Date("2026-09-30T03:20:00.000Z"),
          status_code: 200,
          latency_ms: 45,
          passed: true,
          error_code: null,
          error_message: null,
          environment_id: "env-aws-1",
        },
      ],
    }));

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/deployments/42/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      deploymentId: "42",
      status: "checking",
      phase: "public_url",
      checks: [
        {
          attempt: 1,
          timestamp: "2026-09-30T03:20:00.000Z",
          statusCode: 200,
          latencyMs: 45,
          passed: true,
        },
      ],
      consecutivePassed: 1,
      requiredPasses: 3,
      targetUrl: "https://service-42.example.com/health",
    });
  });

  it("검증 기록이 없는 deployment에 404를 반환함", async () => {
    pool.on(/FROM deployments/, () => ({ rows: [] }));

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/deployments/999/health",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      "NOT_FOUND",
    );
  });

  it("성공 단계의 마지막 연속 성공 횟수를 passed 응답으로 반환함", async () => {
    pool.on(/FROM deployments/, () => ({
      rows: [{ id: 42, status: "succeeded", public_url: "https://example.com" }],
    }));
    pool.on(/FROM deployment_steps/, () => ({
      rows: [{ id: 10, status: "succeeded", step_name: "verify" }],
    }));
    pool.on(/FROM health_check_attempts/, () => ({
      rows: [1, 2, 3].map((attempt) => ({
        attempt,
        checked_at: new Date(`2026-09-30T03:20:0${attempt}.000Z`),
        status_code: 200,
        latency_ms: 40 + attempt,
        passed: true,
        error_code: null,
        error_message: null,
      })),
    }));

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/deployments/42/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "passed",
      consecutivePassed: 3,
      requiredPasses: 3,
    });
  });

  it("완료된 verify 단계와 마지막 실패 사유를 failed 응답으로 반환함", async () => {
    pool.on(/FROM deployments/, () => ({
      rows: [{ id: 42, status: "failed", public_url: "https://example.com" }],
    }));
    pool.on(/FROM deployment_steps/, () => ({
      rows: [
        {
          id: 10,
          status: "failed",
          step_name: "verify",
          message: JSON.stringify({
            targetUrl: "https://example.com/ready",
          }),
        },
      ],
    }));
    pool.on(/FROM health_check_attempts/, () => ({
      rows: [
        {
          attempt: 8,
          checked_at: new Date("2026-09-30T03:21:00.000Z"),
          status_code: null,
          latency_ms: 3_000,
          passed: false,
          error_code: "TIMEOUT",
          error_message: "health check timed out",
          environment_id: "env-aws-1",
        },
      ],
    }));

    const response = await server.inject({
      method: "GET",
      url: "/api/v1/deployments/42/health",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      deploymentId: "42",
      status: "failed",
      consecutivePassed: 0,
      requiredPasses: 3,
      targetUrl: "https://example.com/ready",
      checks: [
        {
          attempt: 8,
          passed: false,
          error: "TIMEOUT",
        },
      ],
    });
  });
});
