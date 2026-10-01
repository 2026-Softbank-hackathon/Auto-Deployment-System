import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "@camellia/db";
import type { WorkerDeps } from "../src/deps.js";
import type { VerifyJobPayload, VerifyResult } from "../src/handlers/verify.js";
import { DeploymentOriginActivator } from "../src/origin-activation.js";
import { createVerifyRequestFingerprint, runVerifyJob } from "../src/verify-orchestrator.js";

const digest = `sha256:${"a".repeat(64)}`;
const awsPayload: VerifyJobPayload = {
  jobId: "verify-deployment-42", attempt: 1, deploymentId: 42,
  environmentId: "12", environmentType: "aws", serviceId: "api",
  targetUrl: "http://demo.ap-northeast-2.elb.amazonaws.com",
  health: { path: "/health", expectedStatus: 200, timeoutMs: 3000 },
  expectedDigest: digest,
};
const onpremPayload: VerifyJobPayload = {
  ...awsPayload, environmentType: "onprem", targetUrl: "https://verify-d42.example.com",
};

function context(payload = awsPayload) {
  return {
    project_id: "4", target_environment_id: "12",
    environment_type: payload.environmentType, status: "verifying",
    public_url: payload.targetUrl, verify_status: "succeeded",
    agent_status: "ready_for_verify",
    agent_result: {
      deploymentId: 42, environmentId: "12", status: "ready_for_verify",
      endpoint: payload.targetUrl, localUrl: "http://127.0.0.1:32145", runningDigest: digest,
    },
  };
}

function cloudflare() {
  return {
    ensureNamedTunnel: vi.fn(async () => ({ id: "tunnel-4", name: "camellia-service-4", endpoint: "tunnel-4.cfargotunnel.com" })),
    setTunnelOrigin: vi.fn(async () => undefined),
    switchServiceOrigin: vi.fn(async () => ({ id: "dns-4", name: "service-4.apps.example.com", content: "origin.example.com", proxied: true })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("DeploymentOriginActivator", () => {
  it("검증한 AWS 배포의 ALB를 고정 서비스 CNAME에 연결한다", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [context()] })
      .mockResolvedValueOnce({ rows: [{ status: "verifying" }] });
    const cf = cloudflare();
    await new DeploymentOriginActivator({ query } as unknown as Pool, {
      cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
    }).activate(awsPayload);

    expect(cf.switchServiceOrigin).toHaveBeenCalledWith({
      zoneId: "zone-1", serviceHostname: "service-4.apps.example.com",
      originHostname: "demo.ap-northeast-2.elb.amazonaws.com",
    });
    expect(cf.ensureNamedTunnel).not.toHaveBeenCalled();
  });

  it("저장된 On-Prem 결과의 동적 loopback 포트를 stable ingress에 연결한다", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [context(onpremPayload)] })
      .mockResolvedValueOnce({ rows: [{ status: "verifying" }] });
    const cf = cloudflare();
    await new DeploymentOriginActivator({ query } as unknown as Pool, {
      cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
    }).activate(onpremPayload);

    expect(cf.setTunnelOrigin).toHaveBeenCalledWith({
      tunnelId: "tunnel-4", hostname: "service-4.apps.example.com", serviceUrl: "http://127.0.0.1:32145",
    });
    expect(cf.switchServiceOrigin).toHaveBeenCalledWith({
      zoneId: "zone-1", serviceHostname: "service-4.apps.example.com", originHostname: "tunnel-4.cfargotunnel.com",
    });
  });

  it.each([
    { verify_status: "failed" }, { status: "cancelled" },
    { target_environment_id: "99" }, { public_url: "http://another.elb.amazonaws.com" },
  ])("실패·취소·다른 환경의 결과는 기존 Origin을 수정하지 않는다: %j", async (override) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...context(), ...override }] });
    const cf = cloudflare();
    await expect(new DeploymentOriginActivator({ query } as unknown as Pool, {
      cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
    }).activate(awsPayload)).rejects.toThrow();
    expect(cf.switchServiceOrigin).not.toHaveBeenCalled();
    expect(cf.setTunnelOrigin).not.toHaveBeenCalled();
  });

  it.each(["http://192.168.1.3:3000", "http://127.0.0.1:3000/private", "http://user:secret@127.0.0.1:3000"])(
    "임의 로컬 origin을 거부한다: %s", async (localUrl) => {
      const row = context(onpremPayload);
      row.agent_result.localUrl = localUrl;
      const query = vi.fn().mockResolvedValue({ rows: [row] });
      const cf = cloudflare();
      await expect(new DeploymentOriginActivator({ query } as unknown as Pool, {
        cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
      }).activate(onpremPayload)).rejects.toThrow();
      expect(cf.ensureNamedTunnel).not.toHaveBeenCalled();
      expect(cf.switchServiceOrigin).not.toHaveBeenCalled();
    },
  );

  it("On-Prem 실행 digest가 기대 이미지와 다르면 활성화를 거부한다", async () => {
    const row = context(onpremPayload);
    row.agent_result.runningDigest = `sha256:${"b".repeat(64)}`;
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const cf = cloudflare();
    await expect(new DeploymentOriginActivator({ query } as unknown as Pool, {
      cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
    }).activate(onpremPayload)).rejects.toThrow("ORIGIN_AGENT_RESULT_MISMATCH");
    expect(cf.switchServiceOrigin).not.toHaveBeenCalled();
  });

  it("외부 작업 직전 취소된 배포는 CNAME을 변경하지 않는다", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [context()] })
      .mockResolvedValueOnce({ rows: [{ status: "cancelled" }] });
    const cf = cloudflare();
    await expect(new DeploymentOriginActivator({ query } as unknown as Pool, {
      cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
    }).activate(awsPayload)).rejects.toThrow("ORIGIN_DEPLOYMENT_NOT_VERIFYING");
    expect(cf.switchServiceOrigin).not.toHaveBeenCalled();
  });

  it("Cloudflare 오류의 비밀 원문을 Worker 로그로 전달하지 않는다", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [context()] })
      .mockResolvedValueOnce({ rows: [{ status: "verifying" }] });
    const cf = cloudflare();
    cf.switchServiceOrigin.mockRejectedValueOnce(new Error("provider echoed SECRET_API_TOKEN"));
    await expect(new DeploymentOriginActivator({ query } as unknown as Pool, {
      cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
    }).activate(awsPayload)).rejects.toThrow("ORIGIN_CLOUDFLARE_FAILED");
  });

  it("이미 성공한 동일 배포의 재실행은 DNS를 다시 전환하지 않는다", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ...context(), status: "succeeded" }] });
    const cf = cloudflare();
    await new DeploymentOriginActivator({ query } as unknown as Pool, {
      cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
    }).activate(awsPayload);
    expect(cf.switchServiceOrigin).not.toHaveBeenCalled();
  });
});

describe("Verify → Origin 활성화 연결", () => {
  it("3회 헬스 성공을 저장한 뒤 활성화하고, 활성화 실패는 검증 기록을 지우지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    let persisted = false;
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("INSERT INTO deployment_steps")) return { rows: [{ id: 10 }] };
      if (sql === "SELECT status FROM deployments WHERE id = $1") return { rows: [{ status: "verifying" }] };
      if (sql.includes("UPDATE deployment_steps")) persisted = params[0] === "succeeded";
      return { rows: [] };
    });
    const activate = vi.fn(async () => {
      expect(persisted).toBe(true);
      throw new Error("ORIGIN_CLOUDFLARE_FAILED");
    });
    const deps = { pool: { query }, boss: {}, storage: {}, originActivator: { activate } } as unknown as WorkerDeps;
    await expect(runVerifyJob({ data: awsPayload }, deps, { sleep: async () => undefined })).rejects.toThrow("ORIGIN_CLOUDFLARE_FAILED");
    expect(activate).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(persisted).toBe(true);
    expect(query.mock.calls.filter(([sql]) => sql.includes("UPDATE deployment_steps"))).toHaveLength(1);
  });

  it("캐시된 헬스 성공 결과는 재검사 없이 Origin 활성화를 재시도한다", async () => {
    const stored: VerifyResult = {
      deploymentId: 42, environmentId: "12", status: "passed", targetUrl: `${awsPayload.targetUrl}/health`,
      checks: [], consecutivePassed: 3, requiredPasses: 3,
      startedAt: "2026-10-01T10:00:00.000Z", finishedAt: "2026-10-01T10:00:10.000Z", durationMs: 10000,
    };
    const query = vi.fn(async (sql: string) => sql.includes("INSERT") ? { rows: [] } : {
      rows: [{ id: 10, deployment_id: 42, status: "succeeded", message: JSON.stringify({
        ...stored, jobId: awsPayload.jobId, requestFingerprint: createVerifyRequestFingerprint(awsPayload),
      }) }],
    });
    const activate = vi.fn().mockRejectedValueOnce(new Error("ORIGIN_CLOUDFLARE_FAILED")).mockResolvedValueOnce(undefined);
    const deps = { pool: { query }, boss: {}, storage: {}, originActivator: { activate } } as unknown as WorkerDeps;
    await expect(runVerifyJob({ data: awsPayload }, deps)).rejects.toThrow("ORIGIN_CLOUDFLARE_FAILED");
    await expect(runVerifyJob({ data: awsPayload }, deps)).resolves.toMatchObject({ status: "passed" });
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it("헬스 실패 결과에서는 Origin을 활성화하지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not ready", { status: 503 })));
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO deployment_steps")) return { rows: [{ id: 10 }] };
      if (sql === "SELECT status FROM deployments WHERE id = $1") return { rows: [{ status: "verifying" }] };
      return { rows: [] };
    });
    const activate = vi.fn();
    const deps = { pool: { query }, boss: {}, storage: {}, originActivator: { activate } } as unknown as WorkerDeps;
    await expect(runVerifyJob({ data: awsPayload }, deps, { sleep: async () => undefined })).resolves.toMatchObject({ status: "failed" });
    expect(activate).not.toHaveBeenCalled();
  });
});
