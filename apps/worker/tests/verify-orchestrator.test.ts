import { describe, expect, it, vi } from "vitest";
import type { Pool } from "@camellia/db";
import {
  claimVerifyStep,
  createVerifyRequestFingerprint,
  finishVerifyStep,
  persistHealthCheckAttempt,
  runVerifyJob,
  VerifyJobConflictError,
  VerifyJobInProgressError,
} from "../src/verify-orchestrator.js";
import type {
  VerifyJobPayload,
  VerifyResult,
} from "../src/handlers/verify.js";
import type { WorkerDeps } from "../src/deps.js";

function makePool(query: ReturnType<typeof vi.fn>): Pool {
  return { query } as unknown as Pool;
}

function makePayload(
  overrides: Partial<VerifyJobPayload> = {},
): VerifyJobPayload {
  return {
    jobId: "verify-job-1",
    attempt: 1,
    deploymentId: 42,
    environmentId: "env-aws-1",
    environmentType: "aws",
    serviceId: "api",
    targetUrl: "https://example.com",
    health: {
      path: "/health",
      expectedStatus: 200,
      timeoutMs: 3_000,
    },
    ...overrides,
  };
}

describe("verify 결과 영속화", () => {
  it("유효하지 않은 payload는 DB 단계를 만들기 전에 실패함", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const invalidPayload = { ...makePayload(), jobId: "" };
    const deps: WorkerDeps = {
      pool: makePool(query),
      boss: {} as WorkerDeps["boss"],
      storage: {} as WorkerDeps["storage"],
    };

    const result = await runVerifyJob(
      { data: invalidPayload },
      deps,
      { sleep: async () => undefined },
    );

    expect(result.failureReason).toBe("validation_error");
    expect(query).not.toHaveBeenCalled();
  });

  it("running 상태의 verify 단계를 생성함", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 10 }] }));

    const payload = makePayload({
      health: { path: "/ready", expectedStatus: 204, timeoutMs: 3_000 },
    });
    const claim = await claimVerifyStep(makePool(query), payload);

    expect(claim).toEqual({ owned: true, stepId: 10 });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO deployment_steps"),
      [
        42,
        "verify-job-1",
        JSON.stringify({
          jobId: "verify-job-1",
          environmentId: "env-aws-1",
          requestFingerprint: createVerifyRequestFingerprint(payload),
          targetUrl: "https://example.com/ready",
        }),
      ],
    );
  });

  it("기본 URL의 query와 fragment를 running 단계에 저장하지 않음", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 10 }] }));
    const payload = makePayload({
      targetUrl: "https://example.com/app?token=secret#internal",
      health: { path: "/ready", expectedStatus: 200, timeoutMs: 3_000 },
    });

    await claimVerifyStep(makePool(query), payload);

    const params = query.mock.calls[0]?.[1] as unknown[];
    expect(JSON.parse(String(params[2]))).toMatchObject({
      targetUrl: "https://example.com/ready",
    });
    expect(String(params[2])).not.toContain("secret");
  });

  it("유효하지 않은 health 경로는 running 단계에 targetUrl을 저장하지 않음", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 10 }] }));
    const payload = makePayload({
      health: {
        path: "//attacker.example/health",
        expectedStatus: 200,
        timeoutMs: 3_000,
      },
    });

    await claimVerifyStep(makePool(query), payload);

    const params = query.mock.calls[0]?.[1] as unknown[];
    expect(JSON.parse(String(params[2]))).not.toHaveProperty("targetUrl");
  });

  it("완료된 동일 job이면 저장된 VerifyResult를 반환함", async () => {
    const storedResult: VerifyResult = {
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
    const payload = makePayload();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "10",
            deployment_id: "42",
            status: "succeeded",
            message: JSON.stringify({
              ...storedResult,
              jobId: payload.jobId,
              requestFingerprint: createVerifyRequestFingerprint(payload),
            }),
          },
        ],
      });

    const claim = await claimVerifyStep(makePool(query), payload);

    expect(claim).toEqual({ owned: false, stepId: 10, result: storedResult });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("동일 job이 실행 중이면 중복 실행을 거부함", async () => {
    const payload = makePayload();
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "10",
            deployment_id: "42",
            status: "running",
            message: JSON.stringify({
              jobId: "verify-job-1",
              environmentId: "env-aws-1",
              requestFingerprint: createVerifyRequestFingerprint(payload),
            }),
          },
        ],
      });

    await expect(
      claimVerifyStep(makePool(query), payload),
    ).rejects.toBeInstanceOf(VerifyJobInProgressError);
  });

  it("동일 job ID에 다른 deployment를 전달하면 충돌로 거부함", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "10",
            deployment_id: "41",
            status: "succeeded",
            message: JSON.stringify({ environmentId: "env-aws-1" }),
          },
        ],
      });

    await expect(
      claimVerifyStep(makePool(query), makePayload()),
    ).rejects.toBeInstanceOf(VerifyJobConflictError);
  });

  it("동일 job ID에 다른 health 설정을 전달하면 충돌로 거부함", async () => {
    const originalPayload = makePayload();
    const changedPayload = makePayload({
      health: { path: "/ready", expectedStatus: 204, timeoutMs: 1_000 },
    });
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "10",
            deployment_id: "42",
            status: "succeeded",
            message: JSON.stringify({
              environmentId: "env-aws-1",
              requestFingerprint:
                createVerifyRequestFingerprint(originalPayload),
            }),
          },
        ],
      });

    await expect(
      claimVerifyStep(makePool(query), changedPayload),
    ).rejects.toBeInstanceOf(VerifyJobConflictError);
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
