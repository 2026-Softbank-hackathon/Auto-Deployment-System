/**
 * 앱 주소(#300) — 공개 주소 CNAME · Tunnel ingress 를 프로젝트 subdomain 으로 만든다.
 */
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "@camellia/db";
import type { VerifyJobPayload } from "../src/handlers/verify.js";
import { DeploymentOriginActivator } from "../src/origin-activation.js";

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

function context(payload: VerifyJobPayload, subdomain: string | null) {
  return {
    project_id: "4", project_subdomain: subdomain, target_environment_id: "12",
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
    ensureCname: vi.fn(async () => ({ id: "dns" })),
    getCname: vi.fn(async (input: { hostname: string }) => ({
      id: "dns-old", name: input.hostname, content: "old-origin.example.com", proxied: true,
    })),
    setTunnelOrigin: vi.fn(async () => ({ previousServiceUrl: null })),
    removeTunnelOrigin: vi.fn(async () => undefined),
    deleteCname: vi.fn(async () => undefined),
    findNamedTunnel: vi.fn(async () => ({ id: "tunnel-4", name: "camellia-service-4", endpoint: "tunnel-4.cfargotunnel.com" })),
    switchServiceOrigin: vi.fn(async (input: { serviceHostname: string; originHostname: string }) => ({
      id: "dns-4", name: input.serviceHostname, content: input.originHostname, proxied: true,
    })),
  };
}

function activator(query: ReturnType<typeof vi.fn>, cf: ReturnType<typeof cloudflare>) {
  return new DeploymentOriginActivator({ query } as unknown as Pool, {
    cloudflare: cf, zoneId: "zone-1", platformDomain: "Example.com.",
  });
}

describe("공개 주소는 프로젝트 subdomain (#300)", () => {
  it("AWS — {subdomain}.{도메인} CNAME 을 ALB 로 바꾼다", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [context(awsPayload, "shop")] })
      .mockResolvedValue({ rows: [{ status: "verifying" }] });
    const cf = cloudflare();

    const receipt = await activator(query, cf).activate(awsPayload);

    expect(String(query.mock.calls[0]![0])).toMatch(/subdomain/);
    expect(cf.switchServiceOrigin).toHaveBeenCalledWith({
      zoneId: "zone-1", serviceHostname: "shop.example.com",
      originHostname: "demo.ap-northeast-2.elb.amazonaws.com",
    });
    expect(receipt?.serviceHostname).toBe("shop.example.com");
  });

  it("온프레미스 — Tunnel ingress 도 {subdomain}.{도메인}", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [context(onpremPayload, "home-shop")] })
      .mockResolvedValue({ rows: [{ status: "verifying" }] });
    const cf = cloudflare();

    await activator(query, cf).activate(onpremPayload);

    expect(cf.setTunnelOrigin).toHaveBeenCalledWith({
      tunnelId: "tunnel-4", hostname: "home-shop.example.com", serviceUrl: "http://127.0.0.1:32145",
    });
    expect(cf.switchServiceOrigin).toHaveBeenCalledWith(expect.objectContaining({
      serviceHostname: "home-shop.example.com",
    }));
  });

  it("subdomain 이 비어 있는 예전 프로젝트는 service-{id}", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [context(awsPayload, null)] })
      .mockResolvedValue({ rows: [{ status: "verifying" }] });
    const cf = cloudflare();

    await activator(query, cf).activate(awsPayload);

    expect(cf.switchServiceOrigin).toHaveBeenCalledWith(expect.objectContaining({
      serviceHostname: "service-4.example.com",
    }));
  });

  it("앱 삭제 — 프로젝트 주소의 CNAME 과 Tunnel ingress 를 지운다", async () => {
    const cf = cloudflare();

    const failures = await activator(vi.fn(), cf).removeProjectOrigins({
      projectId: 4, subdomain: "shop", onpremDeploymentIds: [42],
    });

    expect(failures).toEqual([]);
    expect(cf.deleteCname.mock.calls.map(([input]) => (input as { hostname: string }).hostname)).toEqual([
      "shop.example.com", "verify-d42.example.com",
    ]);
    expect(cf.removeTunnelOrigin.mock.calls.map(([input]) => input)).toEqual([
      { tunnelId: "tunnel-4", hostname: "shop.example.com" },
      { tunnelId: "tunnel-4", hostname: "verify-d42.example.com" },
    ]);
  });
});
