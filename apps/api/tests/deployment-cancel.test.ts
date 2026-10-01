/**
 * apps/api/tests/deployment-cancel.test.ts
 * POST /deployments/:id/cancel — 라우트 + DeploymentService.cancel 단위 테스트.
 *
 * - 정상 흐름: 200 + { deploymentId, status: "cancelled", cancelledAt }
 * - 이미 terminal (succeeded/failed/cancelled/rejected): 409
 * - deployment 없음: 404
 * - reason 전달
 * - DB 트랜잭션 패턴: deployments UPDATE + onprem_agent_jobs UPDATE + env_locks DELETE + pg_notify
 * - contracts schema 일치
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type PgBoss from "pg-boss";
import errorHandlerPlugin, { ApiError } from "../src/plugins/error-handler.js";
import swaggerPlugin from "../src/plugins/swagger.js";
import deploymentsRoutes from "../src/routes/deployments.js";
import { DeploymentService } from "../src/services/deployment-service.js";
import { CancelDeploymentResponseSchema } from "@camellia/contracts";
import type { Pool } from "@camellia/db";
import type { Storage } from "@camellia/storage";

// ── 라우트 단위 테스트 (DeploymentService 모킹) ────────────────────────────────

describe("POST /deployments/:id/cancel — 라우트", () => {
  let server: FastifyInstance;
  const cancelMock = vi.fn();

  beforeEach(async () => {
    cancelMock.mockReset();
    server = Fastify({ logger: false });
    await server.register(errorHandlerPlugin);
    await server.register(swaggerPlugin);
    await server.register(deploymentsRoutes, {
      prefix: "/api/v1/deployments",
      deploymentService: { cancel: cancelMock } as unknown as DeploymentService,
    });
    await server.ready();
  });

  afterEach(async () => server.close());

  it("정상 cancel — 200 + 응답 스키마", async () => {
    const payload = {
      deploymentId: "42",
      status: "cancelled" as const,
      cancelledAt: "2026-10-02T03:00:00.000Z",
    };
    cancelMock.mockResolvedValueOnce(payload);

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/42/cancel",
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(() => CancelDeploymentResponseSchema.parse(body)).not.toThrow();
    expect(body).toEqual(payload);
    expect(cancelMock).toHaveBeenCalledWith(42, undefined);
  });

  it("reason 포함 요청 — 서비스에 reason 전달", async () => {
    cancelMock.mockResolvedValueOnce({
      deploymentId: "42",
      status: "cancelled",
      cancelledAt: "2026-10-02T03:00:00.000Z",
    });

    await server.inject({
      method: "POST",
      url: "/api/v1/deployments/42/cancel",
      payload: { reason: "온프레미스 Agent 미응답" },
    });

    expect(cancelMock).toHaveBeenCalledWith(42, "온프레미스 Agent 미응답");
  });

  it("이미 terminal — 409 전파", async () => {
    cancelMock.mockRejectedValueOnce(
      new ApiError(409, "CONFLICT", "이미 종료된 배포입니다 (status: succeeded)"),
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/42/cancel",
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("CONFLICT");
  });

  it("deployment 없음 — 404", async () => {
    cancelMock.mockRejectedValueOnce(
      new ApiError(404, "NOT_FOUND", "배포 ID 999를 찾을 수 없습니다."),
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/999/cancel",
      payload: {},
    });

    expect(res.statusCode).toBe(404);
  });

  it("잘못된 id — 400", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/-1/cancel",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("reason 500자 초과 — 400 VALIDATION_ERROR", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/deployments/42/cancel",
      payload: { reason: "a".repeat(501) },
    });

    expect(res.statusCode).toBe(400);
  });
});

// ── DeploymentService.cancel 서비스 테스트 ────────────────────────────────────

describe("DeploymentService.cancel", () => {
  type QueryCall = { sql: string; params: unknown[] };

  function makeHarness(initialStatus: string | null) {
    const queries: QueryCall[] = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [] };
        }
        if (sql.includes("SELECT status FROM deployments")) {
          return initialStatus === null
            ? { rows: [] }
            : { rows: [{ status: initialStatus }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;
    const svc = new DeploymentService(
      pool,
      {} as PgBoss,
      {} as Storage,
    );
    return { svc, queries, client, pool };
  }

  it("provisioning 상태 cancel — 트랜잭션 안에 UPDATE deployments + UPDATE onprem_agent_jobs + DELETE env_locks + pg_notify", async () => {
    const { svc, queries } = makeHarness("provisioning");

    const result = await svc.cancel(42, "manual cancel for demo");

    expect(result.deploymentId).toBe("42");
    expect(result.status).toBe("cancelled");
    expect(() =>
      CancelDeploymentResponseSchema.parse(result),
    ).not.toThrow();

    const sqls = queries.map((q) => q.sql);
    expect(sqls).toContain("BEGIN");
    expect(sqls.some((s) => s.includes("UPDATE deployments"))).toBe(true);
    expect(sqls.some((s) => s.includes("UPDATE onprem_agent_jobs"))).toBe(true);
    expect(sqls.some((s) => s.includes("DELETE FROM env_locks"))).toBe(true);
    expect(sqls.some((s) => s.includes("pg_notify"))).toBe(true);
    expect(sqls).toContain("COMMIT");

    // UPDATE deployments 가 cancelled 상태로 + reason 포함
    const updateDep = queries.find((q) => q.sql.includes("UPDATE deployments"));
    expect(updateDep?.params[1]).toBe("manual cancel for demo");

    // pg_notify payload 가 cancelled 상태 포함
    const notify = queries.find((q) => q.sql.includes("pg_notify"));
    const payload = JSON.parse(String(notify?.params[0] ?? "{}"));
    expect(payload).toMatchObject({
      deployment_id: "42",
      event: "state_changed",
      payload: { status: "cancelled" },
    });
  });

  it("이미 succeeded 상태 — 409 + ROLLBACK", async () => {
    const { svc, queries } = makeHarness("succeeded");

    await expect(svc.cancel(42)).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
    });

    expect(queries.map((q) => q.sql)).toContain("ROLLBACK");
    expect(queries.some((q) => q.sql.includes("UPDATE deployments"))).toBe(
      false,
    );
    expect(queries.some((q) => q.sql.includes("DELETE FROM env_locks"))).toBe(
      false,
    );
  });

  it("이미 cancelled 상태 — 409", async () => {
    const { svc } = makeHarness("cancelled");
    await expect(svc.cancel(42)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("deployment 없음 — 404 + ROLLBACK", async () => {
    const { svc, queries } = makeHarness(null);

    await expect(svc.cancel(999)).rejects.toMatchObject({
      statusCode: 404,
      code: "NOT_FOUND",
    });

    expect(queries.map((q) => q.sql)).toContain("ROLLBACK");
  });

  it("reason 미지정 — default 'user_cancelled' 저장", async () => {
    const { svc, queries } = makeHarness("deploying");
    await svc.cancel(42);

    const updateDep = queries.find((q) => q.sql.includes("UPDATE deployments"));
    expect(updateDep?.params[1]).toBe("user_cancelled");
  });
});
