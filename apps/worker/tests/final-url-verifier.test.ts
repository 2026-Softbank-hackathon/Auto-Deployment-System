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
  const hosts: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    hosts.push(request.headers.host ?? "");
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
    port: address.port,
    paths,
    hosts,
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

  // 시스템 resolver 로는 찾을 수 없는 이름(.test). 첫 배포 직후 캐시된 NXDOMAIN 을 흉내 낸다.
  const serviceName = "service-24.camellia.test";
  const notFound = () =>
    Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" });

  it("시스템 resolver 가 NXDOMAIN 이어도 권한 DNS 주소로 접속해 통과한다", async () => {
    const target = await startServer([200]);
    const resolver = { resolve4: vi.fn(async () => ["127.0.0.1"]) };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const result = await new FinalUrlVerifier({ protocol: "http", resolver }).verify(
      input(`${serviceName}:${target.port}`),
      { sleep: async () => undefined },
    );

    expect(result).toMatchObject({
      status: "passed",
      targetUrl: `http://${serviceName}:${target.port}/health`,
      consecutivePassed: 3,
    });
    expect(result.checks).toHaveLength(3);
    expect(target.hosts).toEqual(Array(3).fill(`${serviceName}:${target.port}`));
    expect(resolver.resolve4).toHaveBeenCalledWith(serviceName);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("권한 DNS 에 레코드가 보일 때까지 기다린 뒤 헬스체크를 시작한다", async () => {
    const target = await startServer([200]);
    const resolver = {
      resolve4: vi.fn()
        .mockRejectedValueOnce(notFound())
        .mockRejectedValueOnce(notFound())
        .mockResolvedValue(["127.0.0.1"]),
    };
    const sleep = vi.fn(async () => undefined);

    const result = await new FinalUrlVerifier({
      protocol: "http",
      resolver,
      dnsWaitIntervalMs: 2_000,
    }).verify(input(`${serviceName}:${target.port}`), { sleep });

    expect(result.status).toBe("passed");
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(sleep.mock.calls.slice(0, 2)).toEqual([[2_000], [2_000]]);
  });

  it.each([
    ["origin 이 그대로면 권한 DNS 대기 없이 바로 헬스체크한다", true, 3],
    ["origin 을 바꿨으면 권한 DNS 에 보이는지 먼저 확인한다", undefined, 4],
  ])("%s (#299)", async (_case, originUnchanged, resolveCalls) => {
    const target = await startServer([200]);
    const resolver = { resolve4: vi.fn(async () => ["127.0.0.1"]) };

    const result = await new FinalUrlVerifier({ protocol: "http", resolver }).verify(
      { ...input(`${serviceName}:${target.port}`), ...(originUnchanged ? { originUnchanged } : {}) },
      { sleep: async () => undefined },
    );

    expect(result.status).toBe("passed");
    expect(result.checks).toHaveLength(3);
    // 헬스체크마다 한 번씩 + (대기하면) 대기 확인 한 번
    expect(resolver.resolve4).toHaveBeenCalledTimes(resolveCalls);
  });

  it("헬스체크 중 dns_error 는 실패로 끝내지 않고 재시도한다", async () => {
    const target = await startServer([200]);
    const resolver = {
      resolve4: vi.fn()
        .mockResolvedValueOnce(["127.0.0.1"])
        .mockRejectedValueOnce(notFound())
        .mockResolvedValue(["127.0.0.1"]),
    };

    const result = await new FinalUrlVerifier({ protocol: "http", resolver }).verify(
      input(`${serviceName}:${target.port}`),
      { sleep: async () => undefined },
    );

    expect(result.status).toBe("passed");
    expect(result.checks.map((check) => check.error ?? "ok")).toEqual([
      "dns_error",
      "ok",
      "ok",
      "ok",
    ]);
  });

  it("레코드가 끝내 보이지 않으면 dns_error 로 실패한다", async () => {
    const resolver = { resolve4: vi.fn(async () => { throw notFound(); }) };
    const sleep = vi.fn(async () => undefined);

    const result = await new FinalUrlVerifier({
      resolver,
      dnsWaitAttempts: 3,
    }).verify(input(serviceName), { sleep });

    expect(result).toMatchObject({ status: "failed", failureReason: "dns_error" });
    expect(result.checks).toHaveLength(8);
    expect(resolver.resolve4).toHaveBeenCalledTimes(3 + 8);
  });

  it("서비스 hostname 외의 URL 구성요소를 거부한다", async () => {
    await expect(
      new FinalUrlVerifier().verify(input("user:secret@example.com/path"), {
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("FINAL_URL_HOSTNAME_INVALID");
  });
});
