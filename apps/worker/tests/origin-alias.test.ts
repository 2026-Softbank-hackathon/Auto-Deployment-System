/**
 * 앱 주소 변경 (#301) — 새 주소를 지금 서비스 중인 origin 에 연결 · 되돌리기 · 예전 주소 정리.
 */
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "@camellia/db";
import { DeploymentOriginActivator } from "../src/origin-activation.js";

const ALB = "demo-123.ap-northeast-2.elb.amazonaws.com";
const TUNNEL = "tunnel-4.cfargotunnel.com";

function cloudflare(records: Record<string, { content: string; proxied?: boolean }>) {
  return {
    ensureNamedTunnel: vi.fn(),
    ensureCname: vi.fn(async (input: { hostname: string; target: string; proxied?: boolean }) => ({
      id: "dns-new", name: input.hostname, content: input.target, proxied: input.proxied ?? true,
    })),
    getCname: vi.fn(async (input: { hostname: string }) => {
      const record = records[input.hostname];
      return record ? { id: `dns-${input.hostname}`, name: input.hostname, content: record.content, proxied: record.proxied ?? true } : null;
    }),
    deleteCname: vi.fn(async () => undefined),
    findNamedTunnel: vi.fn(async () => ({ id: "tunnel-4", name: "camellia-service-4", endpoint: TUNNEL })),
    getTunnelOrigin: vi.fn(async (input: { hostname: string }) =>
      input.hostname === "old.example.com" ? "http://127.0.0.1:32145" : null),
    setTunnelOrigin: vi.fn(async () => ({ previousServiceUrl: null })),
    removeTunnelOrigin: vi.fn(async () => undefined),
    switchServiceOrigin: vi.fn(),
  };
}

function activator(cf: ReturnType<typeof cloudflare>) {
  return new DeploymentOriginActivator({ query: vi.fn() } as unknown as Pool, {
    cloudflare: cf, zoneId: "zone-1", platformDomain: "example.com",
  });
}

describe("addServiceAlias — 새 주소를 지금 origin 에 연결", () => {
  it("AWS(ALB) — 예전 주소 레코드와 같은 대상 · 프록시로 새 레코드를 만든다", async () => {
    const cf = cloudflare({ "old.example.com": { content: ALB } });

    const receipt = await activator(cf).addServiceAlias({ projectId: 4, fromSubdomain: "old", toSubdomain: "new" });

    expect(cf.ensureCname).toHaveBeenCalledWith({ zoneId: "zone-1", hostname: "new.example.com", target: ALB, proxied: true });
    expect(cf.setTunnelOrigin).not.toHaveBeenCalled();
    expect(receipt).toEqual({
      hostname: "new.example.com", previousHostname: "old.example.com", origin: ALB, tunnelIngress: null,
    });
  });

  it("온프레미스(Tunnel) — 새 주소 ingress 를 예전 주소와 같은 로컬 포트로 더한 뒤 레코드를 만든다", async () => {
    const cf = cloudflare({ "old.example.com": { content: TUNNEL } });

    const receipt = await activator(cf).addServiceAlias({ projectId: 4, fromSubdomain: "old", toSubdomain: "new" });

    expect(cf.findNamedTunnel).toHaveBeenCalledWith("4");
    expect(cf.getTunnelOrigin).toHaveBeenCalledWith({ tunnelId: "tunnel-4", hostname: "old.example.com" });
    expect(cf.setTunnelOrigin).toHaveBeenCalledWith({
      tunnelId: "tunnel-4", hostname: "new.example.com", serviceUrl: "http://127.0.0.1:32145",
    });
    expect(cf.setTunnelOrigin.mock.invocationCallOrder[0]!).toBeLessThan(cf.ensureCname.mock.invocationCallOrder[0]!);
    expect(cf.ensureCname).toHaveBeenCalledWith({ zoneId: "zone-1", hostname: "new.example.com", target: TUNNEL, proxied: true });
    expect(receipt.tunnelIngress).toEqual({ tunnelId: "tunnel-4", serviceUrl: "http://127.0.0.1:32145" });
  });

  it("예전 주소 레코드가 없으면 ADDRESS_ORIGIN_MISSING", async () => {
    const cf = cloudflare({});

    await expect(activator(cf).addServiceAlias({ projectId: 4, fromSubdomain: "old", toSubdomain: "new" }))
      .rejects.toMatchObject({ code: "ADDRESS_ORIGIN_MISSING" });
    expect(cf.ensureCname).not.toHaveBeenCalled();
  });

  it("새 주소에 다른 대상을 가리키는 레코드가 이미 있으면 덮어쓰지 않는다 (ADDRESS_RECORD_CONFLICT)", async () => {
    const cf = cloudflare({ "old.example.com": { content: ALB }, "new.example.com": { content: "someone-else.example.net" } });

    await expect(activator(cf).addServiceAlias({ projectId: 4, fromSubdomain: "old", toSubdomain: "new" }))
      .rejects.toMatchObject({ code: "ADDRESS_RECORD_CONFLICT" });
    expect(cf.ensureCname).not.toHaveBeenCalled();
  });

  it("Tunnel 을 찾지 못하거나 예전 주소 ingress 가 없으면 ADDRESS_TUNNEL_MISMATCH", async () => {
    const cf = cloudflare({ "old.example.com": { content: TUNNEL } });
    cf.getTunnelOrigin.mockResolvedValue(null);

    await expect(activator(cf).addServiceAlias({ projectId: 4, fromSubdomain: "old", toSubdomain: "new" }))
      .rejects.toMatchObject({ code: "ADDRESS_TUNNEL_MISMATCH" });
    expect(cf.ensureCname).not.toHaveBeenCalled();
  });
});

describe("removeServiceAlias — 실패 시 새 주소만 지운다", () => {
  it("새 레코드(만든 대상일 때만) · 새 ingress(만든 포트일 때만)를 지운다", async () => {
    const cf = cloudflare({});

    await activator(cf).removeServiceAlias({
      hostname: "new.example.com", previousHostname: "old.example.com", origin: TUNNEL,
      tunnelIngress: { tunnelId: "tunnel-4", serviceUrl: "http://127.0.0.1:32145" },
    });

    expect(cf.deleteCname).toHaveBeenCalledWith({ zoneId: "zone-1", hostname: "new.example.com", expectedTarget: TUNNEL });
    expect(cf.removeTunnelOrigin).toHaveBeenCalledWith({
      tunnelId: "tunnel-4", hostname: "new.example.com", expectedServiceUrl: "http://127.0.0.1:32145",
    });
  });
});

describe("removeServiceHostname — 성공 뒤 예전 주소 정리 (best effort)", () => {
  it("예전 레코드와 (Tunnel 이 있으면) 예전 ingress 를 지운다", async () => {
    const cf = cloudflare({ "old.example.com": { content: TUNNEL } });

    const failures = await activator(cf).removeServiceHostname({ projectId: 4, subdomain: "old" });

    expect(failures).toEqual([]);
    expect(cf.deleteCname).toHaveBeenCalledWith({ zoneId: "zone-1", hostname: "old.example.com", expectedTarget: TUNNEL });
    expect(cf.removeTunnelOrigin).toHaveBeenCalledWith({ tunnelId: "tunnel-4", hostname: "old.example.com" });
  });

  it("실패는 모아서 돌려준다", async () => {
    const cf = cloudflare({ "old.example.com": { content: ALB } });
    cf.deleteCname.mockRejectedValue(new Error("down"));
    cf.findNamedTunnel.mockResolvedValue(null as never);

    expect(await activator(cf).removeServiceHostname({ projectId: 4, subdomain: "old" })).toEqual(["DNS old.example.com"]);
    expect(cf.removeTunnelOrigin).not.toHaveBeenCalled();
  });
});
