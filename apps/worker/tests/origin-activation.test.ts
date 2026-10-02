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
const activationReceipt = {
  serviceHostname: "service-4.example.com",
  activatedOrigin: "demo.ap-northeast-2.elb.amazonaws.com",
  previousOrigin: null,
  tunnelIngress: null,
};

function publicResult(status: "passed" | "failed" = "passed"): VerifyResult {
  return {
    deploymentId: 42,
    environmentId: "12",
    status,
    targetUrl: "https://service-4.example.com/health",
    checks: [],
    consecutivePassed: status === "passed" ? 3 : 0,
    requiredPasses: 3,
    startedAt: "2026-10-01T10:00:00.000Z",
    finishedAt: "2026-10-01T10:00:10.000Z",
    durationMs: 10_000,
    ...(status === "failed" ? { failureReason: "timeout" } : {}),
  };
}

function queryPool(query: ReturnType<typeof vi.fn>): Pool {
  return { query } as unknown as Pool;
}

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
    ensureCname: vi.fn(async () => ({ id: "verify-dns-42" })),
    getCname: vi.fn(async () => ({
      id: "dns-old",
      name: "service-4.example.com",
      content: "old-origin.example.com",
      proxied: true,
    })),
    setTunnelOrigin: vi.fn(async () => ({ previousServiceUrl: "http://127.0.0.1:3000" })),
    removeTunnelOrigin: vi.fn(async () => undefined),
    deleteCname: vi.fn(async () => undefined),
    switchServiceOrigin: vi.fn(async (input: { serviceHostname: string; originHostname: string }) => ({
      id: "dns-4",
      name: input.serviceHostname,
      content: input.originHostname,
      proxied: true,
    })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("DeploymentOriginActivator", () => {
  it("Agent Job 실행 전에 검증용 Named Tunnel과 CNAME을 준비한다", async () => {
    const cf = cloudflare();
    const activator = new DeploymentOriginActivator({ query: vi.fn() } as unknown as Pool, {
      cloudflare: cf,
      zoneId: "zone-1",
      platformDomain: "example.com",
    });

    await activator.prepareOnpremVerification({ deploymentId: 42, projectId: 4 });

    expect(cf.ensureNamedTunnel).toHaveBeenCalledWith("4");
    expect(cf.ensureCname).toHaveBeenCalledWith({
      zoneId: "zone-1",
      hostname: "verify-d42.example.com",
      target: "tunnel-4.cfargotunnel.com",
      proxied: true,
    });
  });

  it("검증한 AWS 배포의 ALB를 고정 서비스 CNAME에 연결한다", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [context()] })
      .mockResolvedValueOnce({ rows: [{ status: "verifying" }] });
    const cf = cloudflare();
    const receipt = await new DeploymentOriginActivator({ query } as unknown as Pool, {
      cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
    }).activate(awsPayload);

    expect(cf.switchServiceOrigin).toHaveBeenCalledWith({
      zoneId: "zone-1", serviceHostname: "service-4.example.com",
      originHostname: "demo.ap-northeast-2.elb.amazonaws.com",
    });
    expect(cf.ensureNamedTunnel).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({
      serviceHostname: "service-4.example.com",
      activatedOrigin: "demo.ap-northeast-2.elb.amazonaws.com",
      previousOrigin: {
        hostname: "old-origin.example.com",
        proxied: true,
      },
    });
  });

  it("정적 사이트 — 검증한 S3 웹사이트 endpoint 를 고정 서비스 CNAME 에 연결한다 (#274)", async () => {
    for (const website of [
      "service-4.example.com.s3-website.ap-northeast-2.amazonaws.com",
      "service-4.example.com.s3-website-us-east-1.amazonaws.com",
    ]) {
      const payload = { ...awsPayload, targetUrl: `http://${website}`, health: { ...awsPayload.health, path: "/" } };
      const query = vi.fn().mockResolvedValueOnce({ rows: [context(payload)] })
        .mockResolvedValueOnce({ rows: [{ status: "verifying" }] });
      const cf = cloudflare();
      await new DeploymentOriginActivator({ query } as unknown as Pool, {
        cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
      }).activate(payload);

      expect(cf.switchServiceOrigin).toHaveBeenCalledWith({
        zoneId: "zone-1", serviceHostname: "service-4.example.com", originHostname: website,
      });
    }
  });

  it("AWS 배포의 origin 이 ALB · S3 웹사이트 endpoint 가 아니면 거부한다", async () => {
    const payload = { ...awsPayload, targetUrl: "http://attacker.example.net" };
    const query = vi.fn().mockResolvedValueOnce({ rows: [context(payload)] });
    const cf = cloudflare();
    await expect(new DeploymentOriginActivator({ query } as unknown as Pool, {
      cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
    }).activate(payload)).rejects.toMatchObject({ code: "ORIGIN_ALB_INVALID" });
    expect(cf.switchServiceOrigin).not.toHaveBeenCalled();
  });

  it("최종 URL 실패 시 직전 CNAME target으로 복구한다", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [context()] })
      .mockResolvedValueOnce({ rows: [{ status: "verifying" }] });
    const cf = cloudflare();
    const activator = new DeploymentOriginActivator(queryPool(query), {
      cloudflare: cf,
      zoneId: "zone-1",
      platformDomain: "example.com",
    });
    const receipt = await activator.activate(awsPayload);

    await activator.rollback(receipt);

    expect(cf.ensureCname).toHaveBeenLastCalledWith({
      zoneId: "zone-1",
      hostname: "service-4.example.com",
      target: "old-origin.example.com",
      proxied: true,
    });
  });

  it("직전 CNAME이 없는 최초 배포는 새 레코드를 삭제한다", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [context()] })
      .mockResolvedValueOnce({ rows: [{ status: "verifying" }] });
    const cf = cloudflare();
    cf.getCname.mockResolvedValueOnce(null);
    const activator = new DeploymentOriginActivator(queryPool(query), {
      cloudflare: cf,
      zoneId: "zone-1",
      platformDomain: "example.com",
    });
    const receipt = await activator.activate(awsPayload);

    await activator.rollback(receipt);

    expect(cf.deleteCname).toHaveBeenCalledWith({
      zoneId: "zone-1",
      hostname: "service-4.example.com",
      expectedTarget: "demo.ap-northeast-2.elb.amazonaws.com",
    });
  });

  it("저장된 On-Prem 결과의 동적 loopback 포트를 stable ingress에 연결한다", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [context(onpremPayload)] })
      .mockResolvedValueOnce({ rows: [{ status: "verifying" }] });
    const cf = cloudflare();
    await new DeploymentOriginActivator({ query } as unknown as Pool, {
      cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
    }).activate(onpremPayload);

    expect(cf.setTunnelOrigin).toHaveBeenCalledWith({
      tunnelId: "tunnel-4", hostname: "service-4.example.com", serviceUrl: "http://127.0.0.1:32145",
    });
    expect(cf.switchServiceOrigin).toHaveBeenCalledWith({
      zoneId: "zone-1", serviceHostname: "service-4.example.com", originHostname: "tunnel-4.cfargotunnel.com",
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

  describe("origin 이 그대로면 주소 연결 생략 (#299)", () => {
    function activatorFor(payload: VerifyJobPayload, cf: ReturnType<typeof cloudflare>) {
      const query = vi.fn().mockResolvedValueOnce({ rows: [context(payload)] })
        .mockResolvedValueOnce({ rows: [{ status: "verifying" }] });
      return new DeploymentOriginActivator(queryPool(query), {
        cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
      });
    }
    const record = (content: string, proxied = true) => ({
      id: "dns-4", name: "service-4.example.com", content, proxied,
    });

    it("공개 주소 레코드가 이미 이번 origin 을 프록시로 가리키면 바꾸지 않고 reused 로 남긴다", async () => {
      const cf = cloudflare();
      cf.getCname.mockResolvedValueOnce(record("demo.ap-northeast-2.elb.amazonaws.com"));

      const receipt = await activatorFor(awsPayload, cf).activate(awsPayload);

      expect(cf.switchServiceOrigin).not.toHaveBeenCalled();
      expect(receipt).toEqual({
        serviceHostname: "service-4.example.com",
        activatedOrigin: "demo.ap-northeast-2.elb.amazonaws.com",
        previousOrigin: { hostname: "demo.ap-northeast-2.elb.amazonaws.com", proxied: true },
        tunnelIngress: null,
        reused: true,
      });
    });

    it("reused 활성화를 되돌려도 레코드는 그대로 둔다 (지우지 않음)", async () => {
      const cf = cloudflare();
      cf.getCname.mockResolvedValueOnce(record("demo.ap-northeast-2.elb.amazonaws.com"));
      const activator = activatorFor(awsPayload, cf);
      const receipt = await activator.activate(awsPayload);

      await activator.rollback(receipt!);

      expect(cf.deleteCname).not.toHaveBeenCalled();
      expect(cf.ensureCname).toHaveBeenLastCalledWith({
        zoneId: "zone-1", hostname: "service-4.example.com",
        target: "demo.ap-northeast-2.elb.amazonaws.com", proxied: true,
      });
    });

    it.each([
      ["첫 배포 (레코드 없음)", null],
      ["다른 origin", record("old-origin.example.com")],
      ["온프레미스 → AWS 전환", record("tunnel-4.cfargotunnel.com")],
      ["같은 origin 이지만 프록시가 꺼져 있음", record("demo.ap-northeast-2.elb.amazonaws.com", false)],
    ])("%s → 레코드를 갱신한다", async (_case, existing) => {
      const cf = cloudflare();
      cf.getCname.mockResolvedValueOnce(existing);

      const receipt = await activatorFor(awsPayload, cf).activate(awsPayload);

      expect(cf.switchServiceOrigin).toHaveBeenCalledOnce();
      expect(receipt?.reused).toBeUndefined();
    });

    it("AWS → 온프레미스 전환은 Tunnel ingress 와 레코드를 갱신한다", async () => {
      const cf = cloudflare();
      cf.getCname.mockResolvedValueOnce(record("demo.ap-northeast-2.elb.amazonaws.com"));
      cf.setTunnelOrigin.mockResolvedValueOnce({ previousServiceUrl: null } as never);

      const receipt = await activatorFor(onpremPayload, cf).activate(onpremPayload);

      expect(cf.setTunnelOrigin).toHaveBeenCalledOnce();
      expect(cf.switchServiceOrigin).toHaveBeenCalledOnce();
      expect(receipt?.reused).toBeUndefined();
    });

    it("온프레미스 — 레코드가 같아도 Tunnel ingress 가 바뀌면 reused 가 아니다", async () => {
      const cf = cloudflare();
      cf.getCname.mockResolvedValueOnce(record("tunnel-4.cfargotunnel.com"));

      const receipt = await activatorFor(onpremPayload, cf).activate(onpremPayload);

      expect(cf.setTunnelOrigin).toHaveBeenCalledOnce();
      expect(cf.switchServiceOrigin).toHaveBeenCalledOnce();
      expect(receipt?.reused).toBeUndefined();
    });

    it("온프레미스 — 레코드와 Tunnel ingress 가 모두 그대로면 reused", async () => {
      const cf = cloudflare();
      cf.getCname.mockResolvedValueOnce(record("tunnel-4.cfargotunnel.com"));
      cf.setTunnelOrigin.mockResolvedValueOnce({ previousServiceUrl: "http://127.0.0.1:32145" });

      const receipt = await activatorFor(onpremPayload, cf).activate(onpremPayload);

      expect(cf.switchServiceOrigin).not.toHaveBeenCalled();
      expect(receipt?.reused).toBe(true);
    });
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
      if (sql.includes("UPDATE deployment_steps") && typeof params[0] === "string") {
        persisted = JSON.parse(params[0]).targetResult?.status === "passed";
      }
      return { rows: [] };
    });
    const activate = vi.fn(async () => {
      expect(persisted).toBe(true);
      throw new Error("ORIGIN_CLOUDFLARE_FAILED");
    });
    const deps = {
      pool: { query },
      boss: {},
      storage: {},
      originActivator: { activate, rollback: vi.fn() },
      finalUrlVerifier: { verify: vi.fn(async () => publicResult()) },
    } as unknown as WorkerDeps;
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
    const activate = vi.fn()
      .mockRejectedValueOnce(new Error("ORIGIN_CLOUDFLARE_FAILED"))
      .mockResolvedValueOnce(activationReceipt);
    const deps = {
      pool: { query },
      boss: {},
      storage: {},
      originActivator: { activate, rollback: vi.fn() },
      finalUrlVerifier: { verify: vi.fn(async () => publicResult()) },
    } as unknown as WorkerDeps;
    await expect(runVerifyJob({ data: awsPayload }, deps)).rejects.toThrow("ORIGIN_CLOUDFLARE_FAILED");
    await expect(runVerifyJob({ data: awsPayload }, deps)).resolves.toMatchObject({ status: "passed" });
    expect(activate).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["주소 연결을 생략한(reused) 활성화는 권한 DNS 대기 없이", { ...activationReceipt, reused: true }, true],
    ["레코드를 바꾼 활성화는 지금처럼 권한 DNS 를 기다린 뒤", activationReceipt, undefined],
  ])("%s 공개 주소를 검증한다 (#299)", async (_case, receipt, originUnchanged) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO deployment_steps")) return { rows: [{ id: 10 }] };
      if (sql.includes("SELECT status FROM deployments")) return { rows: [{ status: "verifying" }] };
      return { rows: [] };
    });
    const verify = vi.fn(async () => publicResult());
    const deps = {
      pool: { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) },
      boss: { send: vi.fn() },
      storage: {},
      originActivator: { activate: vi.fn(async () => receipt), rollback: vi.fn() },
      finalUrlVerifier: { verify },
    } as unknown as WorkerDeps;

    await expect(runVerifyJob({ data: awsPayload }, deps, { sleep: async () => undefined }))
      .resolves.toMatchObject({ status: "passed" });

    const [input] = verify.mock.calls[0] as unknown as [{ originUnchanged?: boolean; serviceHostname: string }];
    expect(input.serviceHostname).toBe("service-4.example.com");
    expect(input.originUnchanged).toBe(originUnchanged);
  });

  it("저장된 reused 활성화로 이어서 검증해도 권한 DNS 대기를 생략한다 (#299)", async () => {
    const stored: VerifyResult = {
      deploymentId: 42, environmentId: "12", status: "passed", targetUrl: `${awsPayload.targetUrl}/health`,
      checks: [], consecutivePassed: 3, requiredPasses: 3,
      startedAt: "2026-10-01T10:00:00.000Z", finishedAt: "2026-10-01T10:00:10.000Z", durationMs: 10000,
    };
    const query = vi.fn(async (sql: string) => sql.includes("INSERT") ? { rows: [] } : {
      rows: [{ id: 10, deployment_id: 42, status: "running", message: JSON.stringify({
        jobId: awsPayload.jobId, environmentId: "12",
        requestFingerprint: createVerifyRequestFingerprint(awsPayload),
        phase: "public_url", targetResult: stored,
        activation: { ...activationReceipt, reused: true },
      }) }],
    });
    const activate = vi.fn();
    const verify = vi.fn(async () => publicResult());
    const deps = {
      pool: { query },
      boss: {},
      storage: {},
      originActivator: { activate, rollback: vi.fn() },
      finalUrlVerifier: { verify },
    } as unknown as WorkerDeps;

    await runVerifyJob({ data: awsPayload }, deps).catch(() => undefined);

    expect(activate).not.toHaveBeenCalled();
    const [input] = verify.mock.calls[0] as unknown as [{ originUnchanged?: boolean }];
    expect(input.originUnchanged).toBe(true);
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

describe("DeploymentOriginActivator.removeProjectOrigins (#247 앱 삭제)", () => {
  function activatorWith(cf: ReturnType<typeof cloudflare> & { findNamedTunnel?: ReturnType<typeof vi.fn> }) {
    return new DeploymentOriginActivator({ query: vi.fn() } as unknown as Pool, {
      cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
    });
  }

  it("AWS 만 쓴 앱 — 공개 주소 CNAME 을 현재 target 그대로 지우고 Tunnel 은 건드리지 않는다", async () => {
    const cf = { ...cloudflare(), findNamedTunnel: vi.fn(async () => null) };

    const failures = await activatorWith(cf).removeProjectOrigins({ projectId: 4, onpremDeploymentIds: [] });

    expect(failures).toEqual([]);
    expect(cf.deleteCname).toHaveBeenCalledWith({
      zoneId: "zone-1", hostname: "service-4.example.com", expectedTarget: "old-origin.example.com",
    });
    expect(cf.findNamedTunnel).not.toHaveBeenCalled();
    expect(cf.removeTunnelOrigin).not.toHaveBeenCalled();
    expect(cf.ensureNamedTunnel).not.toHaveBeenCalled();
  });

  it("온프레미스 앱 — 검증용 CNAME 과 프로젝트 Tunnel 의 ingress 규칙(공개 · 검증 주소)도 지운다", async () => {
    const cf = {
      ...cloudflare(),
      findNamedTunnel: vi.fn(async () => ({ id: "tunnel-4", name: "camellia-service-4", endpoint: "tunnel-4.cfargotunnel.com" })),
    };

    const failures = await activatorWith(cf).removeProjectOrigins({ projectId: 4, onpremDeploymentIds: [42, 43] });

    expect(failures).toEqual([]);
    expect(cf.deleteCname.mock.calls.map(([input]) => (input as { hostname: string }).hostname)).toEqual([
      "service-4.example.com", "verify-d42.example.com", "verify-d43.example.com",
    ]);
    expect(cf.findNamedTunnel).toHaveBeenCalledWith("4");
    expect(cf.removeTunnelOrigin.mock.calls.map(([input]) => input)).toEqual([
      { tunnelId: "tunnel-4", hostname: "service-4.example.com" },
      { tunnelId: "tunnel-4", hostname: "verify-d42.example.com" },
      { tunnelId: "tunnel-4", hostname: "verify-d43.example.com" },
    ]);
  });

  it("레코드가 없으면 지우지 않고, 실패는 멈추지 않고 모아서 돌려준다 (best effort)", async () => {
    const cf = {
      ...cloudflare(),
      getCname: vi.fn(async (input: { hostname: string }) =>
        input.hostname.startsWith("verify-d42")
          ? null
          : { id: "dns", name: input.hostname, content: "tunnel-4.cfargotunnel.com", proxied: true }),
      deleteCname: vi.fn(async () => { throw new Error("cloudflare down"); }),
      findNamedTunnel: vi.fn(async () => { throw new Error("cloudflare down"); }),
    };

    const failures = await activatorWith(cf).removeProjectOrigins({ projectId: 4, onpremDeploymentIds: [42] });

    expect(cf.deleteCname).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([
      "DNS service-4.example.com",
      "Tunnel camellia-service-4",
    ]);
  });

  it("Cloudflare 설정이 없으면 ORIGIN_CONFIGURATION_MISSING", async () => {
    const activator = new DeploymentOriginActivator({ query: vi.fn() } as unknown as Pool, {});

    await expect(
      activator.removeProjectOrigins({ projectId: 4, onpremDeploymentIds: [] }),
    ).rejects.toMatchObject({ code: "ORIGIN_CONFIGURATION_MISSING" });
  });
});
