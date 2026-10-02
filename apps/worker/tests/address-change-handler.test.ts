/**
 * apps/worker/tests/address-change-handler.test.ts
 * 앱 주소 변경 잡 (#301) — 새 주소 연결 → 최종 URL 검증 → 성공: subdomain 변경 + 예전 주소 정리 / 실패: 새 주소만 지움.
 */

import { describe, expect, it, vi } from "vitest";
import type { WorkerDeps } from "../src/deps.js";
import { handleAddressChange } from "../src/handlers/address-change.js";
import { OriginActivationError, type ServiceAliasReceipt } from "../src/origin-activation.js";
import type { VerifyResult } from "../src/handlers/verify.js";

const IR = {
  $ir_version: "0.1.0",
  metadata: { name: "shop", version: "1.0.0" },
  services: {
    api: {
      type: "http",
      build: { dockerfile: "Dockerfile" },
      port: 3000,
      health: { path: "/healthz", expected_status: 204, timeout_seconds: 4 },
      expose: "public",
      size: "small",
    },
  },
  deploy: { profile: "aws-ecs-basic" },
};

const RECEIPT: ServiceAliasReceipt = {
  hostname: "new-shop.example.com",
  previousHostname: "service-3.example.com",
  origin: "demo.ap-northeast-2.elb.amazonaws.com",
  tunnelIngress: null,
};

function verifyResult(status: "passed" | "failed"): VerifyResult {
  return {
    deploymentId: 9, environmentId: "12", status, targetUrl: "https://new-shop.example.com/healthz",
    checks: [], consecutivePassed: status === "passed" ? 3 : 0, requiredPasses: 3,
    startedAt: "2026-10-02T03:00:00.000Z", finishedAt: "2026-10-02T03:00:10.000Z", durationMs: 10_000,
    ...(status === "failed" ? { failureReason: "http_502" } : {}),
  };
}

function harness(options: {
  project?: Record<string, unknown> | null;
  live?: Record<string, unknown> | null;
  verify?: "passed" | "failed" | Error;
  aliasError?: Error;
  cleanupFailures?: string[];
  updated?: boolean;
} = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const project = options.project === undefined
    ? { id: "3", subdomain: "service-3", address_change_status: "changing", address_change_to: "new-shop" }
    : options.project;
  const live = options.live === undefined
    ? { id: "9", target_profile: "aws-ecs-basic", target_environment_id: "12", ir_json: IR }
    : options.live;
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const text = sql.replace(/\s+/g, " ").trim();
      queries.push({ sql: text, params });
      if (/FROM projects WHERE id = \$1/.test(text) && text.startsWith("SELECT")) return { rows: project ? [project] : [] };
      if (text.includes("ld.status = 'succeeded'")) return { rows: live ? [live] : [] };
      if (text.startsWith("UPDATE projects SET subdomain")) {
        return { rows: options.updated === false ? [] : [{ id: "3" }] };
      }
      return { rows: [] };
    }),
  };
  const originActivator = {
    addServiceAlias: vi.fn(async () => {
      if (options.aliasError) throw options.aliasError;
      return RECEIPT;
    }),
    removeServiceAlias: vi.fn(async () => undefined),
    removeServiceHostname: vi.fn(async () => options.cleanupFailures ?? []),
  };
  const finalUrlVerifier = {
    verify: vi.fn(async () => {
      if (options.verify instanceof Error) throw options.verify;
      return verifyResult(options.verify ?? "passed");
    }),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps = { pool, boss: {}, storage: {}, log, originActivator, finalUrlVerifier } as unknown as WorkerDeps;
  const failed = () => queries.find((q) => q.sql.includes("address_change_status = 'failed'"));
  const succeeded = () => queries.find((q) => q.sql.startsWith("UPDATE projects SET subdomain"));
  return { deps, queries, originActivator, finalUrlVerifier, log, failed, succeeded };
}

const runtime = { sleep: async () => undefined };

describe("handleAddressChange (#301)", () => {
  it("새 주소를 지금 origin 에 연결 → 앱 헬스체크로 검증 → subdomain 변경 → 예전 주소 정리", async () => {
    const h = harness();

    await handleAddressChange({ data: { project_id: 3 } }, h.deps, runtime);

    expect(h.originActivator.addServiceAlias).toHaveBeenCalledWith({
      projectId: 3, fromSubdomain: "service-3", toSubdomain: "new-shop",
    });
    expect(h.finalUrlVerifier.verify).toHaveBeenCalledWith(
      {
        deploymentId: 9,
        environmentId: "12",
        serviceHostname: "new-shop.example.com",
        health: { path: "/healthz", expectedStatus: 204, timeoutMs: 4000 },
      },
      runtime,
    );
    expect(h.succeeded()?.params).toEqual([3, "new-shop"]);
    expect(h.succeeded()?.sql).toMatch(/address_change_status = 'succeeded'/);
    expect(h.originActivator.removeServiceHostname).toHaveBeenCalledWith({ projectId: 3, subdomain: "service-3" });
    // DB 를 바꾼 뒤에 예전 주소를 지운다
    const updateOrder = h.deps.pool.query as unknown as { mock: { invocationCallOrder: number[]; calls: unknown[][] } };
    const updateIndex = updateOrder.mock.calls.findIndex(([sql]) => String(sql).includes("UPDATE projects SET subdomain"));
    expect(updateOrder.mock.invocationCallOrder[updateIndex]!)
      .toBeLessThan(h.originActivator.removeServiceHostname.mock.invocationCallOrder[0]!);
    expect(h.originActivator.removeServiceAlias).not.toHaveBeenCalled();
    expect(h.failed()).toBeUndefined();
  });

  it("검증에 실패하면 새 주소만 지우고 예전 주소를 둔다 (failed + 이유)", async () => {
    const h = harness({ verify: "failed" });

    await handleAddressChange({ data: { project_id: 3 } }, h.deps, runtime);

    expect(h.originActivator.removeServiceAlias).toHaveBeenCalledWith(RECEIPT);
    expect(h.succeeded()).toBeUndefined();
    expect(h.originActivator.removeServiceHostname).not.toHaveBeenCalled();
    expect(h.failed()?.params).toEqual([3, "ADDRESS_VERIFY_FAILED\nhttp_502"]);
  });

  it("검증 중 오류도 실패로 남기고 새 주소를 지운다", async () => {
    const h = harness({ verify: new Error("FINAL_URL_HOSTNAME_INVALID") });

    await handleAddressChange({ data: { project_id: 3 } }, h.deps, runtime);

    expect(h.originActivator.removeServiceAlias).toHaveBeenCalled();
    expect(String(h.failed()?.params[1])).toMatch(/^ADDRESS_VERIFY_FAILED/);
  });

  it("새 주소 연결에 실패하면 그 코드로 failed (지울 것이 없다)", async () => {
    const h = harness({ aliasError: new OriginActivationError("ADDRESS_RECORD_CONFLICT") });

    await handleAddressChange({ data: { project_id: 3 } }, h.deps, runtime);

    expect(h.originActivator.removeServiceAlias).not.toHaveBeenCalled();
    expect(h.failed()?.params).toEqual([3, "ADDRESS_RECORD_CONFLICT"]);
  });

  it("검증 사이에 요청이 바뀌어 반영하지 못하면 새 주소를 지운다", async () => {
    const h = harness({ updated: false });

    await handleAddressChange({ data: { project_id: 3 } }, h.deps, runtime);

    expect(h.originActivator.removeServiceAlias).toHaveBeenCalled();
    expect(h.originActivator.removeServiceHostname).not.toHaveBeenCalled();
  });

  it("예전 주소 정리 실패는 경고만 남기고 성공으로 둔다", async () => {
    const h = harness({ cleanupFailures: ["DNS service-3.example.com"] });

    await handleAddressChange({ data: { project_id: 3 } }, h.deps, runtime);

    expect(h.succeeded()).toBeDefined();
    expect(h.failed()).toBeUndefined();
    expect(h.log.warn).toHaveBeenCalled();
  });

  it("정적 사이트(S3)로 서비스 중이면 ADDRESS_CHANGE_STATIC_UNSUPPORTED", async () => {
    const h = harness({ live: { id: "9", target_profile: "aws-static-basic", target_environment_id: "12", ir_json: IR } });

    await handleAddressChange({ data: { project_id: 3 } }, h.deps, runtime);

    expect(h.originActivator.addServiceAlias).not.toHaveBeenCalled();
    expect(h.failed()?.params).toEqual([3, "ADDRESS_CHANGE_STATIC_UNSUPPORTED"]);
  });

  it("서비스 중인 배포가 없으면 연결 없이 바로 바꾼다", async () => {
    const h = harness({ live: null });

    await handleAddressChange({ data: { project_id: 3 } }, h.deps, runtime);

    expect(h.originActivator.addServiceAlias).not.toHaveBeenCalled();
    expect(h.succeeded()?.params).toEqual([3, "new-shop"]);
  });

  it("IR 을 읽지 못하면 /health 200 으로 검증한다", async () => {
    const h = harness({ live: { id: "9", target_profile: "aws-lambda-basic", target_environment_id: "12", ir_json: null } });

    await handleAddressChange({ data: { project_id: 3 } }, h.deps, runtime);

    expect(h.finalUrlVerifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({ health: { path: "/health", expectedStatus: 200, timeoutMs: 5000 } }),
      runtime,
    );
  });

  it("주소 변경 중이 아니면(중복 잡 · 이미 끝남) 아무것도 하지 않는다", async () => {
    for (const project of [null, { id: "3", subdomain: "x", address_change_status: "succeeded", address_change_to: "x" }]) {
      const h = harness({ project });
      await handleAddressChange({ data: { project_id: 3 } }, h.deps, runtime);
      expect(h.originActivator.addServiceAlias).not.toHaveBeenCalled();
      expect(h.queries.filter((q) => q.sql.startsWith("UPDATE"))).toEqual([]);
    }
  });
});
