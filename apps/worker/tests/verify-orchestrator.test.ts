import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "@camellia/db";
import {
  claimVerifyStep,
  createVerifyRequestFingerprint,
  finalizeDeploymentState,
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

afterEach(() => vi.unstubAllGlobals());

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
          phase: "target",
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

    expect(claim).toEqual({
      owned: false,
      stepId: 10,
      result: storedResult,
      phase: "target",
      completed: false,
    });
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
        "target",
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
    expect(params.slice(5)).toEqual([null, null, false, "TIMEOUT", "timeout"]);
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
        JSON.stringify({ ...result, phase: "target" }),
        10,
      ],
    );
  });
});

describe("finalizeDeploymentState — verify 결과를 deployment 레벨로 반영", () => {
  function makeTxnHarness(initialStatus = "verifying") {
    let currentStatus = initialStatus;
    const clientQueries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        clientQueries.push({ sql, params });
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          return { rows: [] };
        }
        if (sql.includes("SELECT status FROM deployments")) {
          return { rows: [{ status: currentStatus }] };
        }
        if (sql.includes("UPDATE deployments")) {
          currentStatus = params[0] as string;
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const poolQueries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      connect: vi.fn(async () => client),
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        poolQueries.push({ sql, params });
        return { rows: [] };
      }),
    } as unknown as Pool;
    return {
      pool,
      client,
      clientQueries,
      poolQueries,
      getStatus: () => currentStatus,
    };
  }

  it("succeeded 전이 + env_lock DELETE + SSE state_changed 알림", async () => {
    const harness = makeTxnHarness();
    const bossSend = vi.fn(async () => "job");
    const notify = vi.fn(async () => {});
    const deps = {
      pool: harness.pool,
      boss: { send: bossSend },
      storage: {},
      notifier: { notify },
    } as unknown as WorkerDeps;

    await finalizeDeploymentState(deps, 42, "succeeded");

    expect(harness.getStatus()).toBe("succeeded");
    const lockDelete = harness.poolQueries.find((q) =>
      q.sql.includes("DELETE FROM env_locks"),
    );
    expect(lockDelete?.params).toEqual([42]);
    expect(notify).toHaveBeenCalledWith(42, "state_changed", {
      status: "succeeded",
    });
    // succeeded 는 diagnose 안 큐잉
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("failed 전이 + boss diagnose 큐잉 + env_lock DELETE + SSE 알림", async () => {
    const harness = makeTxnHarness();
    const bossSend = vi.fn(async () => "job");
    const notify = vi.fn(async () => {});
    const deps = {
      pool: harness.pool,
      boss: { send: bossSend },
      storage: {},
      notifier: { notify },
    } as unknown as WorkerDeps;

    await finalizeDeploymentState(deps, 42, "failed", "max_attempts_exceeded");

    expect(harness.getStatus()).toBe("failed");
    expect(bossSend).toHaveBeenCalledWith("diagnose", { deployment_id: 42 });
    const lockDelete = harness.poolQueries.find((q) =>
      q.sql.includes("DELETE FROM env_locks"),
    );
    expect(lockDelete?.params).toEqual([42]);
    expect(notify).toHaveBeenCalledWith(42, "state_changed", {
      status: "failed",
    });
  });

  it("이미 cancelled 등 다른 terminal 상태면 transitionTo 는 예외 삼키고 env_lock·SSE 는 계속", async () => {
    const harness = makeTxnHarness("cancelled");
    const warn = vi.fn();
    const notify = vi.fn(async () => {});
    const deps = {
      pool: harness.pool,
      boss: { send: vi.fn(async () => "job") },
      storage: {},
      notifier: { notify },
      log: { warn, info: vi.fn(), error: vi.fn() },
    } as unknown as WorkerDeps;

    await expect(
      finalizeDeploymentState(deps, 42, "succeeded"),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    // DB 상태는 cancelled 그대로 (transitionTo 가 ROLLBACK)
    expect(harness.getStatus()).toBe("cancelled");
    // env_lock cleanup 은 여전히 시도
    const lockDelete = harness.poolQueries.find((q) =>
      q.sql.includes("DELETE FROM env_locks"),
    );
    expect(lockDelete?.params).toEqual([42]);
    // SSE 는 요청받은 nextStatus 로 발행 (best-effort)
    expect(notify).toHaveBeenCalledWith(42, "state_changed", {
      status: "succeeded",
    });
  });
});

describe("Verify rollout — 고정 URL 검증과 Origin 복구", () => {
  const activation = {
    serviceHostname: "service-7.example.com",
    activatedOrigin: "new-origin.example.com",
    previousOrigin: {
      hostname: "old-origin.example.com",
      proxied: true,
    },
    tunnelIngress: null,
  };

  function result(status: "passed" | "failed"): VerifyResult {
    return {
      deploymentId: 42,
      environmentId: "env-aws-1",
      status,
      targetUrl: "https://service-7.example.com/health",
      checks: [],
      consecutivePassed: status === "passed" ? 3 : 0,
      requiredPasses: 3,
      startedAt: "2026-10-02T03:00:00.000Z",
      finishedAt: "2026-10-02T03:00:10.000Z",
      durationMs: 10_000,
      ...(status === "failed" ? { failureReason: "timeout" } : {}),
    };
  }

  function harness(
    finalStatus: "passed" | "failed",
    rollbackFails = false,
    verifierThrows = false,
  ) {
    let deploymentStatus = "verifying";
    let stepStatus = "running";
    let stepMessage: string | null = null;
    let lockDeleted = false;
    const order: string[] = [];
    const notifications: string[] = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO deployment_steps")) return { rows: [{ id: 10 }] };
      if (sql === "SELECT status FROM deployments WHERE id = $1") {
        return { rows: [{ status: deploymentStatus }] };
      }
      if (sql.includes("UPDATE deployment_steps") && sql.includes("SET status")) {
        stepStatus = String(params[0]);
        stepMessage = String(params[3]);
      }
      if (sql.includes("DELETE FROM env_locks")) lockDeleted = true;
      return { rows: [] };
    });
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("SELECT status FROM deployments")) {
          return { rows: [{ status: deploymentStatus }] };
        }
        if (sql.includes("UPDATE deployments")) {
          deploymentStatus = String(params[0]);
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query,
      connect: vi.fn(async () => client),
    } as unknown as Pool;
    const rollback = vi.fn(async () => {
      order.push("rollback");
      if (rollbackFails) throw new Error("restore failed");
    });
    const verify = vi.fn(async (_input, runtime) => {
      order.push("public_url");
      if (verifierThrows) throw new Error("attempt persistence failed");
      await runtime.onAttempt?.({
        attempt: 1,
        timestamp: "2026-10-02T03:00:00.000Z",
        statusCode: finalStatus === "passed" ? 200 : 503,
        latencyMs: 10,
        passed: finalStatus === "passed",
      });
      return result(finalStatus);
    });
    const deps = {
      pool,
      boss: { send: vi.fn(async () => "diagnose-job") },
      storage: {},
      notifier: {
        notify: vi.fn(async (_deploymentId: number, _event: string, data: { status?: string }) => {
          if (data.status) notifications.push(data.status);
        }),
      },
      originActivator: {
        activate: vi.fn(async () => {
          order.push("activate");
          return activation;
        }),
        rollback,
      },
      finalUrlVerifier: { verify },
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as unknown as WorkerDeps;
    return {
      deps,
      order,
      notifications,
      rollback,
      verify,
      getDeploymentStatus: () => deploymentStatus,
      getStepStatus: () => stepStatus,
      getStepMessage: () => stepMessage,
      isLockDeleted: () => lockDeleted,
    };
  }

  it("Origin 전환 뒤 고정 URL이 성공한 경우에만 succeeded로 전이한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const state = harness("passed");

    await expect(
      runVerifyJob(
        { data: makePayload() },
        state.deps,
        { sleep: async () => undefined },
      ),
    ).resolves.toMatchObject({
      status: "passed",
      targetUrl: "https://service-7.example.com/health",
    });

    expect(state.order).toEqual(["activate", "public_url"]);
    expect(state.getStepStatus()).toBe("succeeded");
    expect(state.getDeploymentStatus()).toBe("succeeded");
    expect(state.isLockDeleted()).toBe(true);
    expect(state.notifications).toEqual(["succeeded"]);
  });

  it("고정 URL 실패 시 Origin을 복구한 뒤 신규 배포를 failed 처리한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const state = harness("failed");

    await expect(
      runVerifyJob(
        { data: makePayload() },
        state.deps,
        { sleep: async () => undefined },
      ),
    ).resolves.toMatchObject({ status: "failed", failureReason: "timeout" });

    expect(state.order).toEqual(["activate", "public_url", "rollback"]);
    expect(state.rollback).toHaveBeenCalledWith(activation);
    expect(state.getStepStatus()).toBe("failed");
    expect(state.getDeploymentStatus()).toBe("failed");
    expect(state.isLockDeleted()).toBe(true);
    expect(state.notifications).toEqual(["rollback", "failed"]);
  });

  it("Origin 복구가 실패하면 rollback 상태와 환경 락을 유지한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const state = harness("failed", true);

    await expect(
      runVerifyJob(
        { data: makePayload() },
        state.deps,
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow("ORIGIN_ROLLBACK_FAILED");

    expect(state.getDeploymentStatus()).toBe("rollback");
    expect(state.isLockDeleted()).toBe(false);
    expect(state.notifications).toEqual(["rollback"]);
  });

  it("고정 URL 검사 중 내부 오류가 나도 복구 영수증을 단계 결과에 보존한다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const state = harness("failed", false, true);

    await expect(
      runVerifyJob(
        { data: makePayload() },
        state.deps,
        { sleep: async () => undefined },
      ),
    ).rejects.toThrow("attempt persistence failed");

    expect(state.rollback).toHaveBeenCalledWith(activation);
    expect(state.getDeploymentStatus()).toBe("failed");
    expect(state.isLockDeleted()).toBe(true);
    expect(JSON.parse(state.getStepMessage() ?? "{}")).toMatchObject({
      status: "failed",
      phase: "public_url",
      failureReason: "verify_internal_error",
      activation,
    });
  });

  it("rollback 상태의 재시도는 저장된 영수증으로 Origin 복구만 다시 수행한다", async () => {
    const payload = makePayload();
    const publicResult = result("failed");
    const targetResult = {
      ...result("passed"),
      targetUrl: "https://example.com/health",
    };
    let deploymentStatus = "rollback";
    let lockDeleted = false;
    const rollback = vi.fn(async () => undefined);
    const verify = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO deployment_steps")) return { rows: [] };
      if (sql.includes("FROM deployment_steps")) {
        return {
          rows: [{
            id: 10,
            deployment_id: 42,
            status: "failed",
            message: JSON.stringify({
              ...publicResult,
              phase: "public_url",
              targetResult,
              activation,
              jobId: payload.jobId,
              requestFingerprint: createVerifyRequestFingerprint(payload),
            }),
          }],
        };
      }
      if (sql === "SELECT status FROM deployments WHERE id = $1") {
        return { rows: [{ status: deploymentStatus }] };
      }
      if (sql.includes("DELETE FROM env_locks")) lockDeleted = true;
      return { rows: [] };
    });
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("SELECT status FROM deployments")) {
          return { rows: [{ status: deploymentStatus }] };
        }
        if (sql.includes("UPDATE deployments")) {
          deploymentStatus = String(params[0]);
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const deps = {
      pool: {
        query,
        connect: vi.fn(async () => client),
      } as unknown as Pool,
      boss: { send: vi.fn(async () => "diagnose-job") },
      storage: {},
      notifier: { notify: vi.fn(async () => undefined) },
      originActivator: { activate: vi.fn(), rollback },
      finalUrlVerifier: { verify },
      log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as unknown as WorkerDeps;

    await expect(
      runVerifyJob({ data: payload }, deps, { sleep: async () => undefined }),
    ).resolves.toMatchObject({ status: "failed", failureReason: "timeout" });

    expect(rollback).toHaveBeenCalledWith(activation);
    expect(verify).not.toHaveBeenCalled();
    expect(deploymentStatus).toBe("failed");
    expect(lockDeleted).toBe(true);
  });
});
