import { describe, expect, it, vi } from "vitest";
import type { VerifyResult } from "../src/handlers/verify.js";
import {
  FailoverMonitor,
  isEligibleFailoverCandidate,
  loadFailoverConfig,
  type FailoverCandidate,
  type FailoverLockedStore,
  type FailoverStore,
} from "../src/failover-monitor.js";

const now = new Date("2026-10-03T03:00:00.000Z");
const digest = `sha256:${"a".repeat(64)}`;

function candidate(overrides: Partial<FailoverCandidate> = {}): FailoverCandidate {
  return {
    projectId: 7,
    activeDeploymentId: 42,
    standbyDeploymentId: 41,
    activeStatus: "succeeded",
    standbyStatus: "succeeded",
    activeEnvironmentType: "onprem",
    standbyEnvironmentType: "aws",
    hasStatefulResources: false,
    activeDigest: digest,
    standbyDigest: digest,
    agentLastSeenAt: new Date(now.getTime() - 9_000),
    serviceHostname: "demo.camellia-deploy.app",
    standbyTargetUrl: "http://demo-alb.ap-northeast-2.elb.amazonaws.com",
    standbyEnvironmentId: "2",
    health: { path: "/health", expectedStatus: 200, timeoutMs: 1_000 },
    ...overrides,
  };
}

function passedResult(): VerifyResult {
  return {
    deploymentId: 41,
    environmentId: "2",
    status: "passed",
    targetUrl: "https://demo.camellia-deploy.app/health",
    checks: [],
    consecutivePassed: 3,
    requiredPasses: 3,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    durationMs: 0,
  };
}

function harness(input: {
  current?: FailoverCandidate;
  probe?: (url: string) => boolean;
  finalStatus?: "passed" | "failed";
} = {}) {
  const current = input.current ?? candidate();
  const markStandbyActive = vi.fn(async () => true);
  const locked: FailoverLockedStore = {
    loadCandidate: vi.fn(async () => current),
    markStandbyActive,
  };
  const store: FailoverStore = {
    listCandidates: vi.fn(async () => [current]),
    withProjectLock: vi.fn(async (_projectId, task) => {
      await task(locked);
      return true;
    }),
  };
  const activateAwsStandby = vi.fn(async () => ({
    serviceHostname: current.serviceHostname,
    activatedOrigin: new URL(current.standbyTargetUrl).hostname,
    previousOrigin: { hostname: "old.cfargotunnel.com", proxied: true },
    tunnelIngress: null,
  }));
  const rollback = vi.fn(async () => undefined);
  const verify = vi.fn(async () => ({
    ...passedResult(),
    status: input.finalStatus ?? "passed",
    ...((input.finalStatus ?? "passed") === "failed"
      ? { consecutivePassed: 0, failureReason: "timeout" }
      : {}),
  }));
  const monitor = new FailoverMonitor({
    store,
    originActivator: { activateAwsStandby, rollback },
    finalUrlVerifier: { verify },
    probe: vi.fn(async (url: string) => input.probe?.(url) ?? !url.includes("camellia-deploy.app")),
    config: {
      enabled: true,
      checkIntervalMs: 2_000,
      heartbeatIntervalMs: 2_000,
      agentTimeoutMs: 8_000,
      publicFailureThreshold: 3,
      candidateRequiredPasses: 3,
      candidateMaxAttempts: 8,
      probeIntervalMs: 2_000,
      cooldownMs: 300_000,
    },
    now: () => now,
    sleep: async () => undefined,
  });
  return { monitor, store, locked, activateAwsStandby, rollback, verify, markStandbyActive };
}

describe("automatic failover config (#349)", () => {
  it("8초 timeout은 2초 heartbeat의 세 배 이상일 때만 허용한다", () => {
    expect(loadFailoverConfig({
      FAILOVER_ENABLED: "true",
      FAILOVER_AGENT_HEARTBEAT_INTERVAL_MS: "2000",
      FAILOVER_AGENT_TIMEOUT_MS: "8000",
    })).toMatchObject({ heartbeatIntervalMs: 2_000, agentTimeoutMs: 8_000 });

    expect(() => loadFailoverConfig({
      FAILOVER_ENABLED: "true",
      FAILOVER_AGENT_HEARTBEAT_INTERVAL_MS: "3000",
      FAILOVER_AGENT_TIMEOUT_MS: "8000",
    })).toThrow("FAILOVER_AGENT_TIMEOUT_MS");
  });
});

describe("FailoverMonitor (#349)", () => {
  it("Heartbeat가 아직 유효하면 공개 URL을 검사하거나 전환하지 않는다", async () => {
    const state = harness({
      current: candidate({ agentLastSeenAt: new Date(now.getTime() - 7_000) }),
    });

    await state.monitor.runOnce();

    expect(state.activateAwsStandby).not.toHaveBeenCalled();
    expect(state.markStandbyActive).not.toHaveBeenCalled();
  });

  it("Heartbeat가 만료돼도 공개 URL이 한 번이라도 정상이면 전환하지 않는다", async () => {
    let calls = 0;
    const state = harness({
      probe: (url) => url.includes("camellia-deploy.app") ? ++calls === 2 : true,
    });

    await state.monitor.runOnce();

    expect(state.activateAwsStandby).not.toHaveBeenCalled();
  });

  it("두 신호가 실패하면 AWS 후보를 3회 확인하고 Origin과 active deployment를 전환한다", async () => {
    const state = harness();

    await state.monitor.runOnce();

    expect(state.activateAwsStandby).toHaveBeenCalledWith({
      projectId: 7,
      activeDeploymentId: 42,
      standbyDeploymentId: 41,
    });
    expect(state.verify).toHaveBeenCalled();
    expect(state.markStandbyActive).toHaveBeenCalledWith(42, 41);
  });

  it("digest가 다르면 Origin을 전환하지 않는다", async () => {
    const mismatched = candidate({ standbyDigest: `sha256:${"b".repeat(64)}` });
    expect(isEligibleFailoverCandidate(mismatched)).toBe(false);
    const state = harness({ current: mismatched });

    await state.monitor.runOnce();

    expect(state.activateAwsStandby).not.toHaveBeenCalled();
  });

  it("최종 공개 URL 검증 실패 시 Origin을 복구하고 active deployment를 유지한다", async () => {
    const state = harness({ finalStatus: "failed" });

    await state.monitor.runOnce();

    expect(state.rollback).toHaveBeenCalled();
    expect(state.markStandbyActive).not.toHaveBeenCalled();
  });
});
