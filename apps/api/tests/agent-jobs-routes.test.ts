import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/plugins/error-handler.js";
import authPlugin from "../src/plugins/auth.js";
import agentJobsRoutes from "../src/routes/agent-jobs.js";

let server: FastifyInstance;
let claimNext: ReturnType<typeof vi.fn>;
let authenticate: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  claimNext = vi.fn(async () => null);
  authenticate = vi.fn(async (token: string) => token === "valid-agent-key"
    ? { agentId: 7, environmentId: 12 }
    : null);
  server = Fastify({ logger: false });
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({ error: { code: error.code } });
    }
    return reply.status(500).send({ error: { code: "INTERNAL_ERROR" } });
  });
  await server.register(authPlugin, {
    apiKey: "platform-api-key",
    nodeEnv: "production",
    agentJobClaimEnabled: true,
  });
  server.register(agentJobsRoutes, {
    prefix: "/api/v1/agents",
    agentJobService: { claimNext },
    authenticate,
    pollTimeoutMs: 10,
    pollIntervalMs: 1,
  });
  await server.ready();
});

afterEach(async () => {
  await server.close();
});

describe("POST /jobs/claim", () => {
  it("Agent Bearer 인증 후 할당된 job을 반환하고 해당 환경만 조회한다", async () => {
    const job = {
      jobId: "73",
      attempt: 1,
      deploymentId: 73,
      environmentId: "12",
      plan: { target: "onprem" },
      image: { digest: `sha256:${"a".repeat(64)}` },
    };
    claimNext.mockResolvedValueOnce(job);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/claim",
      headers: { authorization: "Bearer valid-agent-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ job });
    expect(authenticate).toHaveBeenCalledWith("valid-agent-key");
    expect(claimNext).toHaveBeenCalledWith(7, 12, 90);
  });

  it("인증 토큰이 없거나 틀리면 job claim을 시도하지 않는다", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/claim",
      headers: { authorization: "Bearer invalid-agent-key" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
    expect(claimNext).not.toHaveBeenCalled();
  });

  it("Agent 전용 인증 우회는 정확한 claim 경로에만 적용한다", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/other",
      headers: { authorization: "Bearer valid-agent-key" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("대기 제한시간에 job이 없으면 빈 응답을 반환한다", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/claim",
      headers: { authorization: "Bearer valid-agent-key" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ job: null });
    expect(claimNext).toHaveBeenCalled();
    expect(claimNext.mock.calls.length).toBeGreaterThan(1);
  });

  it("heartbeat 계약과 맞지 않는 비숫자 jobId는 반환하지 않는다", async () => {
    claimNext.mockResolvedValueOnce({
      jobId: "onprem-job-73",
      attempt: 1,
      deploymentId: 73,
      environmentId: "12",
      plan: { target: "onprem" },
      image: { digest: `sha256:${"a".repeat(64)}` },
    });

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/claim",
      headers: { authorization: "Bearer valid-agent-key" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("AGENT_JOB_PAYLOAD_INVALID");
  });
});
