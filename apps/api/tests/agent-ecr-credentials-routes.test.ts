import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/plugins/error-handler.js";
import authPlugin from "../src/plugins/auth.js";
import agentEcrCredentialRoutes from "../src/routes/agent-ecr-credentials.js";

let server: FastifyInstance;
let issue: ReturnType<typeof vi.fn>;
let authenticate: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  issue = vi.fn(async () => ({
    registry: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
    username: "AWS" as const,
    password: "ONE_TIME_ECR_PASSWORD",
    expiresAt: "2026-10-01T10:00:00.000Z",
  }));
  authenticate = vi.fn(async (token: string) => token === "agent-key"
    ? { agentId: 7, environmentId: 12 }
    : null);
  server = Fastify({ logger: false });
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({ error: { code: error.code } });
    }
    if (typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR" } });
    }
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR" } });
  });
  await server.register(authPlugin, {
    apiKey: "platform-api-key",
    nodeEnv: "production",
    agentEcrCredentialEnabled: true,
  });
  server.register(agentEcrCredentialRoutes, {
    prefix: "/api/v1/agents",
    service: { issue },
    authenticate,
  });
  await server.ready();
});

afterEach(async () => {
  await server.close();
});

describe("POST /jobs/:jobId/ecr-credential", () => {
  it("Agent Bearer key로 인증해 credential을 조회한다", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/73/ecr-credential",
      headers: { authorization: "Bearer agent-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      registry: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
      username: "AWS",
      password: "ONE_TIME_ECR_PASSWORD",
      expiresAt: "2026-10-01T10:00:00.000Z",
    });
    expect(authenticate).toHaveBeenCalledWith("agent-key");
    expect(issue).toHaveBeenCalledWith({
      agent: { agentId: 7, environmentId: 12 },
      jobId: "73",
    });
  });

  it("플랫폼 인증이나 잘못된 Agent 키만으로는 자격증명을 주지 않는다", async () => {
    for (const authorization of [undefined, "Bearer invalid-agent-key", "Bearer platform-api-key"]) {
      const response = await server.inject({
        method: "POST",
        url: "/api/v1/agents/jobs/73/ecr-credential",
        ...(authorization ? { headers: { authorization } } : {}),
      });
      expect(response.statusCode).toBe(401);
    }
    expect(issue).not.toHaveBeenCalled();
  });

  it("숫자가 아닌 Job ID는 service에 전달하지 않는다", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/not-a-number/ecr-credential",
      headers: { authorization: "Bearer agent-key" },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(issue).not.toHaveBeenCalled();
  });

  it("Agent 전용 우회는 다른 API 경로에 적용하지 않는다", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/73/ecr-credential/other",
      headers: { authorization: "Bearer agent-key" },
    });

    expect(response.statusCode).toBe(401);
    expect(issue).not.toHaveBeenCalled();
  });
});
