import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AgentControlPlaneHttpClient } from "../src/control-plane-client.js";
import type { AgentCredential } from "../src/credential-store.js";
import { createJob } from "./fixtures.js";

type CapturedRequest = {
  method?: string;
  url?: string;
  authorization?: string;
  body?: unknown;
};

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : undefined;
}

describe("Agent Control Plane HTTP Client", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  });

  async function listen(
    handler: (request: IncomingMessage) => Promise<{ status: number; body?: unknown }>,
  ): Promise<string> {
    const server = createServer(async (request, response) => {
      const result = await handler(request);
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(result.body === undefined ? undefined : JSON.stringify(result.body));
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("테스트 서버 주소 없음");
    return `http://127.0.0.1:${address.port}`;
  }

  function credential(controlPlaneUrl: string): AgentCredential {
    return {
      controlPlaneUrl,
      agentId: "7",
      environmentId: "12",
      agentKey: "agent-key-must-not-leak",
    };
  }

  it("Bearer 인증으로 claim·ECR·Tunnel·결과 보고를 정해진 경로에 전송한다", async () => {
    const requests: CapturedRequest[] = [];
    const job = createJob({ jobId: "73", deploymentId: 73, environmentId: "12" });
    const baseUrl = await listen(async (request) => {
      const body = await readBody(request);
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        ...(body === undefined ? {} : { body }),
      });
      if (request.url === "/api/v1/agents/jobs/claim") {
        return { status: 200, body: { job } };
      }
      if (request.url === "/api/v1/agents/jobs/73/ecr-credential") {
        return {
          status: 200,
          body: {
            registry: "123456789012.dkr.ecr.ap-northeast-2.amazonaws.com",
            username: "AWS",
            password: "temporary-password",
            expiresAt: "2026-10-01T01:00:00.000Z",
          },
        };
      }
      if (request.url === "/api/v1/agents/jobs/73/tunnel") {
        return {
          status: 200,
          body: {
            tunnelId: "tunnel-73",
            token: "tunnel-token",
            hostname: "verify-d73.camellia-deploy.app",
          },
        };
      }
      return { status: 204 };
    });
    const client = new AgentControlPlaneHttpClient(credential(baseUrl));

    expect(await client.claimJob()).toEqual(job);
    expect(await client.getEcrCredential("73")).toMatchObject({ username: "AWS" });
    expect(
      await client.prepareTunnel({
        jobId: "73",
        deploymentId: 73,
        environmentId: "12",
        localPort: 49_152,
      }),
    ).toMatchObject({ tunnelId: "tunnel-73" });
    const result = {
      deploymentId: 73,
      environmentId: "12",
      jobId: "73",
      status: "failed" as const,
      imageUri: `${job.image.repositoryUri}@${job.image.digest}`,
      errorCode: "internal_error" as const,
      errorMessage: "test",
      startedAt: "2026-10-01T00:00:00.000Z",
      finishedAt: "2026-10-01T00:00:01.000Z",
    };
    await client.reportResult("73", result);

    expect(requests).toEqual([
      {
        method: "POST",
        url: "/api/v1/agents/jobs/claim",
        authorization: "Bearer agent-key-must-not-leak",
      },
      {
        method: "POST",
        url: "/api/v1/agents/jobs/73/ecr-credential",
        authorization: "Bearer agent-key-must-not-leak",
      },
      {
        method: "POST",
        url: "/api/v1/agents/jobs/73/tunnel",
        authorization: "Bearer agent-key-must-not-leak",
        body: { deploymentId: 73, environmentId: "12", localPort: 49_152 },
      },
      {
        method: "POST",
        url: "/api/v1/agents/jobs/73/result",
        authorization: "Bearer agent-key-must-not-leak",
        body: result,
      },
    ]);
  });

  it("heartbeat에 런타임 inventory를 보내고 요구 배포와 취소 신호를 반환한다", async () => {
    const baseUrl = await listen(async (request) => {
      expect(await readBody(request)).toEqual({
        currentJobId: "73",
        runtimes: [{
          deploymentId: "73",
          digest: `sha256:${"a".repeat(64)}`,
          status: "running",
          health: "healthy",
        }],
      });
      return {
        status: 200,
        body: { ok: true, deploymentCancelled: true, desiredDeploymentIds: ["73"] },
      };
    });
    const client = new AgentControlPlaneHttpClient(credential(baseUrl));

    await expect(client.sendHeartbeat("73", [{
      deploymentId: "73",
      digest: `sha256:${"a".repeat(64)}`,
      status: "running",
      health: "healthy",
    }])).resolves.toEqual({ jobCancelled: true, desiredDeploymentIds: ["73"] });
  });

  it("cleanup Job claim과 결과 보고를 별도 API로 처리한다", async () => {
    const requests: CapturedRequest[] = [];
    const cleanupJob = {
      jobId: "cleanup-73",
      attempt: 1,
      deploymentId: 73,
      environmentId: "12",
      reason: "project_deleted",
    };
    const baseUrl = await listen(async (request) => {
      const body = await readBody(request);
      requests.push({
        method: request.method,
        url: request.url,
        ...(body === undefined ? {} : { body }),
      });
      if (request.url === "/api/v1/agents/cleanup-jobs/claim") {
        return { status: 200, body: { job: cleanupJob } };
      }
      return { status: 204 };
    });
    const client = new AgentControlPlaneHttpClient(credential(baseUrl));
    const result = {
      ...cleanupJob,
      status: "succeeded" as const,
      startedAt: "2026-10-02T00:00:00.000Z",
      finishedAt: "2026-10-02T00:00:01.000Z",
    };

    await expect(client.claimCleanupJob()).resolves.toEqual(cleanupJob);
    await client.reportCleanupResult(cleanupJob.jobId, result);

    expect(requests).toEqual([
      { method: "POST", url: "/api/v1/agents/cleanup-jobs/claim" },
      {
        method: "POST",
        url: "/api/v1/agents/cleanup-jobs/cleanup-73/result",
        body: result,
      },
    ]);
  });

  it("서버 오류에 Agent Key·ECR·Tunnel 응답 본문을 노출하지 않는다", async () => {
    const secret = "server-secret-must-not-leak";
    const baseUrl = await listen(async (request) => {
      await readBody(request);
      return { status: 500, body: { error: secret } };
    });
    const client = new AgentControlPlaneHttpClient(credential(baseUrl));

    let error: unknown;
    try {
      await client.getEcrCredential("73");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("agent-key-must-not-leak");
  });
});
