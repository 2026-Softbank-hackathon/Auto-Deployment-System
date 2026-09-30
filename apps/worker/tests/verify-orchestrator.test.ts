import { describe, expect, it, vi } from "vitest";
import type { Pool } from "@camellia/db";
import {
  finishVerifyStep,
  persistHealthCheckAttempt,
  startVerifyStep,
} from "../src/verify-orchestrator.js";
import type { VerifyResult } from "../src/handlers/verify.js";

function makePool(query: ReturnType<typeof vi.fn>): Pool {
  return { query } as unknown as Pool;
}

describe("verify 결과 영속화", () => {
  it("running 상태의 verify 단계를 생성함", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 10 }] }));

    const stepId = await startVerifyStep(makePool(query), 42);

    expect(stepId).toBe(10);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO deployment_steps"),
      [42],
    );
  });

  it("헬스체크 시도를 환경과 시도 번호 기준으로 저장함", async () => {
    const query = vi.fn(async () => ({ rows: [] }));

    await persistHealthCheckAttempt(makePool(query), 10, "env-aws-1", {
      attempt: 2,
      timestamp: "2026-09-30T03:20:00.000Z",
      statusCode: 503,
      latencyMs: 45,
      passed: false,
      error: "unexpected_status: expected 200, received 503",
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO health_check_attempts"),
      [
        10,
        "env-aws-1",
        2,
        new Date("2026-09-30T03:20:00.000Z"),
        503,
        45,
        false,
        "UNEXPECTED_STATUS",
        "unexpected_status: expected 200, received 503",
      ],
    );
  });

  it("응답이 없는 실패는 nullable 컬럼과 오류 코드를 저장함", async () => {
    const query = vi.fn(async () => ({ rows: [] }));

    await persistHealthCheckAttempt(makePool(query), 10, "env-aws-1", {
      attempt: 1,
      timestamp: "2026-09-30T03:20:00.000Z",
      passed: false,
      error: "timeout",
    });

    const params = query.mock.calls[0]?.[1] as unknown[];
    expect(params.slice(4)).toEqual([null, null, false, "TIMEOUT", "timeout"]);
  });

  it("VerifyResult를 단계 요약으로 완료 처리함", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const result: VerifyResult = {
      deploymentId: 42,
      environmentId: "env-aws-1",
      status: "passed",
      targetUrl: "https://example.com/health",
      checks: [],
      consecutivePassed: 3,
      requiredPasses: 3,
      startedAt: "2026-09-30T03:20:00.000Z",
      finishedAt: "2026-09-30T03:20:10.000Z",
      durationMs: 10_000,
    };

    await finishVerifyStep(makePool(query), 10, result);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE deployment_steps"),
      [
        "succeeded",
        new Date("2026-09-30T03:20:10.000Z"),
        10_000,
        JSON.stringify(result),
        10,
      ],
    );
  });
});
