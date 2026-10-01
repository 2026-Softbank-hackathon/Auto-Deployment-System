import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentIdentityHttpClient,
  ensureAgentCredential,
} from "../src/agent-identity.js";
import { FileAgentCredentialStore } from "../src/credential-store.js";

type CapturedRequest = {
  url: string;
  authorization?: string;
  body: unknown;
};

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : undefined;
}

describe("Agent 등록과 장기 인증키 사용", () => {
  const servers: Server[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  });

  async function listen(
    handler: (request: IncomingMessage) => Promise<{
      status: number;
      body: unknown;
    }>,
  ): Promise<string> {
    const server = createServer(async (request, response) => {
      const result = await handler(request);
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
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

  async function createStore(): Promise<FileAgentCredentialStore> {
    const root = await mkdtemp(join(tmpdir(), "camellia-agent-identity-"));
    roots.push(root);
    return new FileAgentCredentialStore(join(root, "state"));
  }

  it("1회용 등록 토큰으로 등록하고 저장한 장기 Key를 Heartbeat Bearer 인증에 사용한다", async () => {
    const requests: CapturedRequest[] = [];
    const baseUrl = await listen(async (request) => {
      requests.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body: await requestBody(request),
      });
      if (request.url === "/api/v1/agents/register") {
        return {
          status: 201,
          body: {
            agentId: "5",
            environmentId: "10",
            longLivedKey: "long-lived-agent-key",
          },
        };
      }
      return { status: 200, body: { ok: true } };
    });
    const store = await createStore();
    const client = new AgentIdentityHttpClient(baseUrl);

    const credential = await ensureAgentCredential({
      store,
      client,
      registrationToken: "one-time-registration-token",
    });
    await client.sendHeartbeat(credential);

    expect(requests).toEqual([
      {
        url: "/api/v1/agents/register",
        authorization: undefined,
        body: { registrationToken: "one-time-registration-token" },
      },
      {
        url: "/api/v1/agents/heartbeat",
        authorization: "Bearer long-lived-agent-key",
        body: {},
      },
    ]);
    expect(await store.load()).toEqual(credential);
  });

  it("저장된 인증정보가 있으면 등록 토큰 없이 재사용하고 등록 API를 호출하지 않는다", async () => {
    let registrationCount = 0;
    const baseUrl = await listen(async (request) => {
      if (request.url === "/api/v1/agents/register") registrationCount += 1;
      await requestBody(request);
      return {
        status: 201,
        body: { agentId: "5", environmentId: "10", longLivedKey: "new-key" },
      };
    });
    const store = await createStore();
    await store.save({
      controlPlaneUrl: baseUrl,
      agentId: "5",
      environmentId: "10",
      agentKey: "stored-agent-key",
    });

    const credential = await ensureAgentCredential({
      store,
      client: new AgentIdentityHttpClient(baseUrl),
    });

    expect(credential.agentKey).toBe("stored-agent-key");
    expect(registrationCount).toBe(0);
  });

  it("등록 실패 오류와 잘못된 응답에 토큰·응답 본문을 포함하지 않는다", async () => {
    const registrationToken = "registration-token-must-not-leak";
    const baseUrl = await listen(async (request) => {
      await requestBody(request);
      return {
        status: 400,
        body: { error: { message: registrationToken } },
      };
    });
    const store = await createStore();

    let error: unknown;
    try {
      await ensureAgentCredential({
        store,
        client: new AgentIdentityHttpClient(baseUrl),
        registrationToken,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(registrationToken);
    expect(String(error)).not.toContain("error");
    expect(await store.load()).toBeNull();
  });

  it("원격 HTTP Control Plane과 경로가 포함된 URL을 거부한다", () => {
    expect(() => new AgentIdentityHttpClient("http://api.example.com")).toThrow();
    expect(() => new AgentIdentityHttpClient("https://api.example.com/base")).toThrow();
    expect(() => new AgentIdentityHttpClient("https://api.example.com")).not.toThrow();
    expect(() => new AgentIdentityHttpClient("http://127.0.0.1:3000")).not.toThrow();
  });
});
