/**
 * apps/api/tests/redeploy-to-target.test.ts
 * POST /api/v1/deployments/:id/redeploy-to-target 단위 테스트
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import errorHandlerPlugin, { ApiError } from "../src/plugins/error-handler.js";
import swaggerPlugin from "../src/plugins/swagger.js";
import deploymentsRoutes from "../src/routes/deployments.js";
import type { DeploymentService } from "../src/services/deployment-service.js";
import { RedeployToTargetResponseSchema } from "@camellia/contracts";

let server: FastifyInstance;

const redeployToTarget = vi.fn(async () => ({
  deploymentId: "99",
  status: "queued" as const,
  eventsUrl: "/api/v1/deployments/99/events",
}));

const create = vi.fn(async () => ({
  deploymentId: "42",
  status: "received" as const,
  eventsUrl: "/api/v1/deployments/42/events",
}));

const get = vi.fn(async () => {
  throw new Error("not implemented in this test");
});

beforeEach(async () => {
  redeployToTarget.mockClear();
  create.mockClear();
  server = Fastify({ logger: false });
  await server.register(errorHandlerPlugin);
  await server.register(swaggerPlugin);
  await server.register(deploymentsRoutes, {
    prefix: "/api/v1/deployments",
    deploymentService: { create, get, redeployToTarget } as unknown as DeploymentService,
  });
  await server.ready();
});

afterEach(async () => server.close());

async function post(id: string | number, body: unknown) {
  return server.inject({
    method: "POST",
    url: `/api/v1/deployments/${id}/redeploy-to-target`,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

describe("POST /deployments/:id/redeploy-to-target", () => {
  it("aws → onprem 전환 요청 시 202 + deploymentId 응답", async () => {
    const res = await post(42, { target: "onprem" });
    expect(res.statusCode, res.body).toBe(202);
    const body = res.json();
    expect(() => RedeployToTargetResponseSchema.parse(body)).not.toThrow();
    expect(body.deploymentId).toBe("99");
    expect(body.status).toBe("queued");
    expect(redeployToTarget).toHaveBeenCalledWith(42, { target: "onprem", environmentId: undefined });
  });

  it("onprem → aws 전환 + targetEnvironmentId 지정 시 202", async () => {
    const res = await post(7, { target: "aws", targetEnvironmentId: "123" });
    expect(res.statusCode, res.body).toBe(202);
    expect(redeployToTarget).toHaveBeenCalledWith(7, { target: "aws", environmentId: 123 });
  });

  it("target 미지정 시 400", async () => {
    const res = await post(42, {});
    expect(res.statusCode).toBe(400);
    expect(redeployToTarget).not.toHaveBeenCalled();
  });

  it("잘못된 target 값 시 400", async () => {
    const res = await post(42, { target: "gcp" });
    expect(res.statusCode).toBe(400);
    expect(redeployToTarget).not.toHaveBeenCalled();
  });

  it("잘못된 배포 ID(0) 시 400", async () => {
    const res = await post(0, { target: "aws" });
    expect(res.statusCode).toBe(400);
    expect(redeployToTarget).not.toHaveBeenCalled();
  });

  it("잘못된 배포 ID(문자) 시 400", async () => {
    const res = await post("abc", { target: "aws" });
    expect(res.statusCode).toBe(400);
    expect(redeployToTarget).not.toHaveBeenCalled();
  });

  it("서비스가 409 CONFLICT 던지면 409 반환", async () => {
    redeployToTarget.mockRejectedValueOnce(
      new ApiError(409, "CONFLICT", "진행 중", "배포가 완료된 뒤 재시도하세요."),
    );
    const res = await post(42, { target: "onprem" });
    expect(res.statusCode).toBe(409);
  });

  it("서비스가 404 NOT_FOUND 던지면 404 반환", async () => {
    redeployToTarget.mockRejectedValueOnce(
      new ApiError(404, "NOT_FOUND", "not found"),
    );
    const res = await post(999, { target: "onprem" });
    expect(res.statusCode).toBe(404);
  });
});

describe("RedeployToTargetResponseSchema (contracts)", () => {
  it("유효한 응답 파싱 성공", () => {
    const data = {
      deploymentId: "99",
      status: "queued",
      eventsUrl: "/api/v1/deployments/99/events",
    };
    expect(() => RedeployToTargetResponseSchema.parse(data)).not.toThrow();
  });

  it("status가 'queued'가 아니면 파싱 실패", () => {
    const data = {
      deploymentId: "99",
      status: "received",
      eventsUrl: "/api/v1/deployments/99/events",
    };
    expect(() => RedeployToTargetResponseSchema.parse(data)).toThrow();
  });

  it("deploymentId가 비숫자면 파싱 실패", () => {
    const data = {
      deploymentId: "abc",
      status: "queued",
      eventsUrl: "/api/v1/deployments/99/events",
    };
    expect(() => RedeployToTargetResponseSchema.parse(data)).toThrow();
  });
});
