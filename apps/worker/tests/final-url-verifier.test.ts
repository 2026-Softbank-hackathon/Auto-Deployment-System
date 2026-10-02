import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FinalUrlVerifier } from "../src/final-url-verifier.js";

const activeServers: Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    activeServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startServer(statuses: number[]) {
  let requestCount = 0;
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    const status = statuses[Math.min(requestCount, statuses.length - 1)] ?? 500;
    requestCount += 1;
    response.writeHead(status);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  activeServers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server unavailable");
  return {
    hostname: `127.0.0.1:${address.port}`,
    paths,
    get requestCount() {
      return requestCount;
    },
  };
}

function input(serviceHostname: string) {
  return {
    deploymentId: 42,
    environmentId: "env-aws-1",
    serviceHostname,
    health: {
      path: "/health",
      expectedStatus: 200,
      timeoutMs: 3_000,
    },
  };
}

describe("FinalUrlVerifier", () => {
  it("고정 서비스 URL이 3회 연속 성공하면 passed 결과를 반환한다", async () => {
    const target = await startServer([200, 200, 200]);
    const sleep = vi.fn(async () => undefined);
    const onAttempt = vi.fn(async () => undefined);

    const result = await new FinalUrlVerifier({ protocol: "http" }).verify(input(target.hostname), {
      sleep,
      onAttempt,
    });

    expect(result).toMatchObject({
      deploymentId: 42,
      environmentId: "env-aws-1",
      status: "passed",
      targetUrl: `http://${target.hostname}/health`,
      consecutivePassed: 3,
      requiredPasses: 3,
    });
    expect(result.checks).toHaveLength(3);
    expect(target.paths).toEqual(["/health", "/health", "/health"]);
    expect(onAttempt).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("중간 실패 뒤 연속 성공 횟수를 초기화한다", async () => {
    const target = await startServer([200, 200, 503, 200, 200, 200]);

    const result = await new FinalUrlVerifier({ protocol: "http" }).verify(input(target.hostname), {
      sleep: async () => undefined,
    });

    expect(result.status).toBe("passed");
    expect(result.checks.map((check) => check.passed)).toEqual([
      true,
      true,
      false,
      true,
      true,
      true,
    ]);
    expect(result.consecutivePassed).toBe(3);
  });

  it("최대 8회 안에 연속 성공하지 못하면 failed를 반환한다", async () => {
    const target = await startServer([503]);
    const sleep = vi.fn(async () => undefined);

    const result = await new FinalUrlVerifier({ protocol: "http" }).verify(input(target.hostname), {
      sleep,
    });

    expect(result.status).toBe("failed");
    expect(result.checks).toHaveLength(8);
    expect(result.failureReason).toContain("unexpected_status");
    expect(target.requestCount).toBe(8);
    expect(sleep).toHaveBeenCalledTimes(7);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it("서비스 hostname 외의 URL 구성요소를 거부한다", async () => {
    await expect(
      new FinalUrlVerifier().verify(input("user:secret@example.com/path"), {
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("FINAL_URL_HOSTNAME_INVALID");
  });
});
