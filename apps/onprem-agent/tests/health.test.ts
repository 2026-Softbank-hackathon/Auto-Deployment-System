import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalHealthChecker } from "../src/health.js";
import { createJob } from "./fixtures.js";

describe("LocalHealthChecker", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("기본 readiness 창에서 아홉 번째 시도에 준비되는 정상 앱을 기다린다", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length < 9) throw new TypeError("connection refused");
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const checker = new LocalHealthChecker({ fetcher });

    const result = expect(
      checker.waitUntilHealthy("http://127.0.0.1:49152", createJob()),
    ).resolves.toBeUndefined();
    await vi.runAllTimersAsync();

    await result;
    expect(fetcher).toHaveBeenCalledTimes(9);
  });

  it("최종 실패에 응답 본문 없이 마지막 HTTP 상태를 남긴다", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response("sensitive body", { status: 503 })) as unknown as typeof fetch;
    const checker = new LocalHealthChecker({ attempts: 2, intervalMs: 1, fetcher });

    const result = checker
      .waitUntilHealthy("http://127.0.0.1:49152", createJob())
      .catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    const error = await result;
    expect(error).toMatchObject({
      code: "health_check_failed",
      message: expect.stringContaining("HTTP 503"),
    });
    expect((error as Error).message).not.toContain("sensitive body");
  });
});
