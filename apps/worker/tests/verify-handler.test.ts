import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleVerify,
  type VerifyJobPayload,
  type VerifyRuntime,
} from "../src/handlers/verify.js";
import type { WorkerDeps } from "../src/deps.js";

const activeServers: Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    activeServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

async function startStatusServer(statuses: number[], responseDelayMs = 0) {
  let requestCount = 0;
  const paths: string[] = [];

  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    const status = statuses[Math.min(requestCount, statuses.length - 1)] ?? 500;
    requestCount += 1;

    setTimeout(() => {
      response.writeHead(status);
      response.end();
    }, responseDelayMs);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  activeServers.push(server);

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("테스트 HTTP 서버 주소를 확인할 수 없음");
  }

  return {
    targetUrl: `http://127.0.0.1:${address.port}`,
    paths,
    get requestCount() {
      return requestCount;
    },
  };
}

function makePayload(
  targetUrl: string,
  overrides: Partial<VerifyJobPayload> = {}
): VerifyJobPayload {
  return {
    jobId: "verify-job-1",
    attempt: 1,
    deploymentId: 42,
    environmentId: "env-aws-1",
    environmentType: "aws",
    serviceId: "api",
    targetUrl,
    health: {
      path: "/health",
      expectedStatus: 200,
      timeoutMs: 3_000,
    },
    ...overrides,
  };
}

function makeDeps(status = "verifying"): WorkerDeps {
  const query = vi.fn(async (sql: string) => {
    if (/SELECT.+status.+FROM deployments/is.test(sql)) {
      return { rows: [{ status }] };
    }
    return { rows: [] };
  });

  const client = {
    query,
    release: vi.fn(),
  };

  return {
    pool: {
      query,
      connect: vi.fn(async () => client),
    } as unknown as WorkerDeps["pool"],
    boss: {} as WorkerDeps["boss"],
    storage: {} as WorkerDeps["storage"],
  };
}

function makeRuntime(signal?: AbortSignal) {
  return {
    sleep: vi.fn(async () => undefined),
    signal,
  } satisfies VerifyRuntime;
}

describe("handleVerify", () => {
  it("기대 상태가 3회 연속 반환되면 passed 결과를 반환함", async () => {
    const target = await startStatusServer([200, 200, 200]);
    const runtime = makeRuntime();

    const result = await handleVerify(
      { data: makePayload(target.targetUrl) },
      makeDeps(),
      runtime
    );

    expect(result).toMatchObject({
      deploymentId: 42,
      environmentId: "env-aws-1",
      status: "passed",
      consecutivePassed: 3,
      requiredPasses: 3,
      targetUrl: `${target.targetUrl}/health`,
    });
    expect(result.checks).toHaveLength(3);
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(result.checks.map((check) => check.attempt)).toEqual([1, 2, 3]);
    expect(
      result.checks.every(
        (check) =>
          Number.isFinite(Date.parse(check.timestamp)) &&
          (check.latencyMs ?? -1) >= 0,
      ),
    ).toBe(true);
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(
      Date.parse(result.startedAt),
    );
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(target.paths).toEqual(["/health", "/health", "/health"]);
    expect(runtime.sleep).toHaveBeenCalledTimes(2);
    expect(runtime.sleep).toHaveBeenCalledWith(5_000);
  });

  it("중간 실패가 발생하면 연속 성공 횟수를 0으로 초기화함", async () => {
    const target = await startStatusServer([200, 200, 500, 200, 200, 200]);

    const result = await handleVerify(
      { data: makePayload(target.targetUrl) },
      makeDeps(),
      makeRuntime()
    );

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
    expect(target.requestCount).toBe(6);
  });

  it("payload의 기대 상태 코드와 정확히 일치할 때만 성공 처리함", async () => {
    const target = await startStatusServer([200, 204, 204, 204]);
    const payload = makePayload(target.targetUrl, {
      health: { path: "/ready", expectedStatus: 204, timeoutMs: 3_000 },
    });

    const result = await handleVerify({ data: payload }, makeDeps(), makeRuntime());

    expect(result.status).toBe("passed");
    expect(result.checks.map((check) => check.passed)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    expect(target.paths).toEqual(["/ready", "/ready", "/ready", "/ready"]);
  });

  it("8회 안에 3회 연속 성공하지 못하면 failed 결과를 반환함", async () => {
    const target = await startStatusServer([503]);
    const runtime = makeRuntime();

    const result = await handleVerify(
      { data: makePayload(target.targetUrl) },
      makeDeps(),
      runtime
    );

    expect(result.status).toBe("failed");
    expect(result.checks).toHaveLength(8);
    expect(result.consecutivePassed).toBe(0);
    expect(result.failureReason).toBeTruthy();
    expect(runtime.sleep).toHaveBeenCalledTimes(7);
  });

  it("응답 제한 시간을 넘긴 요청을 timeout 실패로 기록함", async () => {
    const target = await startStatusServer([200], 50);
    const payload = makePayload(target.targetUrl, {
      health: { path: "/health", expectedStatus: 200, timeoutMs: 10 },
    });

    const result = await handleVerify({ data: payload }, makeDeps(), makeRuntime());

    expect(result.status).toBe("failed");
    expect(result.checks).toHaveLength(8);
    expect(result.checks.every((check) => check.passed === false)).toBe(true);
    expect(result.checks.every((check) => check.error?.includes("timeout"))).toBe(true);
  });

  it.each([
    ["DNS 실패", "ENOTFOUND", "dns_error"],
    ["연결 거부", "ECONNREFUSED", "connection_refused"],
    ["TLS 실패", "CERT_HAS_EXPIRED", "tls_error"],
  ])("%s를 분류 가능한 오류로 기록함", async (_name, code, expectedError) => {
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: { code },
    });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(fetchError)));

    const result = await handleVerify(
      { data: makePayload("https://example.com") },
      makeDeps(),
      makeRuntime(),
    );

    expect(result.status).toBe("failed");
    expect(result.checks).toHaveLength(8);
    expect(result.checks.every((check) => check.error === expectedError)).toBe(
      true,
    );
  });

  it("절대 URL 형태의 health path로 origin을 변경하지 못하게 거부함", async () => {
    const target = await startStatusServer([200]);
    const payload = makePayload(target.targetUrl, {
      health: {
        path: "//attacker.example/health",
        expectedStatus: 200,
        timeoutMs: 3_000,
      },
    });

    const result = await handleVerify({ data: payload }, makeDeps(), makeRuntime());

    expect(result).toMatchObject({ status: "failed", checks: [] });
    expect(result.failureReason).toBeTruthy();
    expect(target.requestCount).toBe(0);
  });

  it("범위를 벗어난 기대 상태 코드를 요청 전에 거부함", async () => {
    const target = await startStatusServer([200]);
    const payload = makePayload(target.targetUrl, {
      health: { path: "/health", expectedStatus: 600, timeoutMs: 3_000 },
    });

    const result = await handleVerify({ data: payload }, makeDeps(), makeRuntime());

    expect(result).toMatchObject({
      status: "failed",
      checks: [],
      failureReason: "validation_error",
    });
    expect(target.requestCount).toBe(0);
  });

  it("이미 종료된 deployment이면 HTTP 요청 없이 실패 결과를 반환함", async () => {
    const target = await startStatusServer([200]);

    const result = await handleVerify(
      { data: makePayload(target.targetUrl) },
      makeDeps("succeeded"),
      makeRuntime()
    );

    expect(result).toMatchObject({ status: "failed", checks: [] });
    expect(target.requestCount).toBe(0);
  });

  it("취소된 signal을 받으면 추가 HTTP 요청을 실행하지 않음", async () => {
    const target = await startStatusServer([200]);
    const controller = new AbortController();
    controller.abort();

    const result = await handleVerify(
      { data: makePayload(target.targetUrl) },
      makeDeps(),
      makeRuntime(controller.signal)
    );

    expect(result).toMatchObject({ status: "failed", checks: [] });
    expect(result.failureReason?.toLowerCase()).toContain("cancel");
    expect(target.requestCount).toBe(0);
  });

  it("진행 중인 요청이 취소되면 이후 재시도를 실행하지 않음", async () => {
    const target = await startStatusServer([200], 100);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await handleVerify(
      { data: makePayload(target.targetUrl) },
      makeDeps(),
      makeRuntime(controller.signal),
    );

    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("cancelled");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]?.error).toBe("cancelled");
    expect(target.requestCount).toBe(1);
  });

  it("온프레미스 환경 식별자를 최종 결과에 그대로 유지함", async () => {
    const target = await startStatusServer([200, 200, 200]);
    const payload = makePayload(target.targetUrl, {
      environmentId: "env-onprem-1",
      environmentType: "onprem",
    });

    const result = await handleVerify({ data: payload }, makeDeps(), makeRuntime());

    expect(result).toMatchObject({
      status: "passed",
      environmentId: "env-onprem-1",
    });
  });
});
