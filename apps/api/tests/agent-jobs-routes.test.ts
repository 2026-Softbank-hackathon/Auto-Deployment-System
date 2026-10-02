import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/plugins/error-handler.js";
import authPlugin from "../src/plugins/auth.js";
import agentJobsRoutes from "../src/routes/agent-jobs.js";

let server: FastifyInstance;
let claimNext: ReturnType<typeof vi.fn>;
let authenticate: ReturnType<typeof vi.fn>;
let prepareTunnel: ReturnType<typeof vi.fn>;
let reportResult: ReturnType<typeof vi.fn>;
let claimCleanupNext: ReturnType<typeof vi.fn>;
let reportCleanupResult: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  claimNext = vi.fn(async () => null);
  prepareTunnel = vi.fn(async () => ({
    tunnelId: "tunnel-73",
    token: "tunnel-token",
    hostname: "verify-d73.camellia-deploy.app",
  }));
  reportResult = vi.fn(async () => undefined);
  claimCleanupNext = vi.fn(async () => null);
  reportCleanupResult = vi.fn(async () => undefined);
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
    agentJobService: {
      claimNext,
      prepareTunnel,
      reportResult,
    },
    agentCleanupJobService: {
      claimNext: claimCleanupNext,
      reportResult: reportCleanupResult,
    },
    authenticate,
    pollTimeoutMs: 10,
    pollIntervalMs: 1,
  });
  await server.ready();
});

describe("Agent Job 실행 API", () => {
  it("동적 localPort만 서버 Tunnel 준비 경계에 전달한다", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/73/tunnel",
      headers: { authorization: "Bearer valid-agent-key" },
      payload: { deploymentId: 73, environmentId: "12", localPort: 49_152 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      tunnelId: "tunnel-73",
      token: "tunnel-token",
      hostname: "verify-d73.camellia-deploy.app",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(prepareTunnel).toHaveBeenCalledWith(7, 12, "73", {
      deploymentId: 73,
      environmentId: "12",
      localPort: 49_152,
    });
  });

  it("Agent 결과를 인증된 Job 소유권과 함께 제출한다", async () => {
    const result = {
      deploymentId: 73,
      environmentId: "12",
      jobId: "73",
      status: "ready_for_verify",
      imageUri: `123456789012.dkr.ecr.ap-northeast-2.amazonaws.com/camellia/projects/1@sha256:${"a".repeat(64)}`,
      runningDigest: `sha256:${"a".repeat(64)}`,
      localUrl: "http://127.0.0.1:49152",
      endpoint: "https://verify-d73.camellia-deploy.app",
      startedAt: "2026-10-01T00:00:00.000Z",
      finishedAt: "2026-10-01T00:00:01.000Z",
    };
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/73/result",
      headers: { authorization: "Bearer valid-agent-key" },
      payload: result,
    });

    expect(response.statusCode).toBe(204);
    expect(reportResult).toHaveBeenCalledWith(7, 12, "73", result);
  });

  it("다른 Agent Key와 잘못된 localPort·result 계약을 거부한다", async () => {
    const unauthorized = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/73/tunnel",
      headers: { authorization: "Bearer wrong-key" },
      payload: { deploymentId: 73, environmentId: "12", localPort: 49_152 },
    });
    const invalidTunnel = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/73/tunnel",
      headers: { authorization: "Bearer valid-agent-key" },
      payload: { deploymentId: 73, environmentId: "12", localPort: 70_000 },
    });
    const invalidResult = await server.inject({
      method: "POST",
      url: "/api/v1/agents/jobs/73/result",
      headers: { authorization: "Bearer valid-agent-key" },
      payload: { status: "ready_for_verify" },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(invalidTunnel.statusCode).toBe(400);
    expect(invalidResult.statusCode).toBe(400);
    expect(prepareTunnel).not.toHaveBeenCalled();
    expect(reportResult).not.toHaveBeenCalled();
  });
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

describe("Agent cleanup Job API", () => {
  it("cleanup Job을 비차단 claim하고 성공 결과를 저장한다", async () => {
    const job = {
      jobId: "cleanup-73",
      attempt: 1,
      deploymentId: 73,
      environmentId: "12",
      reason: "project_deleted",
    };
    claimCleanupNext.mockResolvedValueOnce(job);

    const claim = await server.inject({
      method: "POST",
      url: "/api/v1/agents/cleanup-jobs/claim",
      headers: { authorization: "Bearer valid-agent-key" },
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toEqual({ job });
    expect(claimCleanupNext).toHaveBeenCalledWith(7, 12, 90);

    const result = {
      ...job,
      status: "succeeded",
      startedAt: "2026-10-02T00:00:00.000Z",
      finishedAt: "2026-10-02T00:00:01.000Z",
    };
    const report = await server.inject({
      method: "POST",
      url: "/api/v1/agents/cleanup-jobs/cleanup-73/result",
      headers: { authorization: "Bearer valid-agent-key" },
      payload: result,
    });
    expect(report.statusCode).toBe(204);
    expect(reportCleanupResult).toHaveBeenCalledWith(7, 12, "cleanup-73", result);
  });

  it("잘못된 cleanup 결과와 인증되지 않은 claim을 거부한다", async () => {
    const unauthorized = await server.inject({
      method: "POST",
      url: "/api/v1/agents/cleanup-jobs/claim",
    });
    const invalid = await server.inject({
      method: "POST",
      url: "/api/v1/agents/cleanup-jobs/cleanup-73/result",
      headers: { authorization: "Bearer valid-agent-key" },
      payload: { status: "succeeded" },
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(invalid.statusCode).toBe(400);
    expect(reportCleanupResult).not.toHaveBeenCalled();
  });
});
