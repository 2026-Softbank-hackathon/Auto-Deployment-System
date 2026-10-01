import { describe, expect, it, vi } from "vitest";
import { CloudflareApiError, CloudflareClient, tunnelNameForService } from "../src/index.js";

const options = {
  accountId: "account-1",
  apiToken: "secret-token",
  apiRoot: "https://cf.test/client/v4",
};

function apiResponse<T>(result: T, status = 200): Response {
  return new Response(JSON.stringify({ success: true, result }), { status });
}

describe("CloudflareClient", () => {
  it("기존 Zone을 account 범위에서 재사용한다", async () => {
    const fetcher = vi.fn(async () => apiResponse([
      {
        id: "zone-1",
        name: "apps.example.com",
        status: "active",
        account: { id: "account-1" },
        name_servers: ["ns1.example.net", "ns2.example.net"],
      },
    ]));
    const client = new CloudflareClient({ ...options, fetcher });

    await expect(client.ensureZone("Apps.Example.com.")).resolves.toEqual({
      id: "zone-1",
      name: "apps.example.com",
      status: "active",
      nameServers: ["ns1.example.net", "ns2.example.net"],
    });
    const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(request[0])).toContain("account.id=account-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("누락된 Zone을 생성하고 pending 상태를 nameserver와 함께 반환한다", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(apiResponse([]))
      .mockResolvedValueOnce(apiResponse({
        id: "zone-2",
        name: "apps.example.com",
        status: "pending",
        account: { id: "account-1" },
        name_servers: ["ns-a.example.net", "ns-b.example.net"],
      }));
    const client = new CloudflareClient({ ...options, fetcher });

    await expect(client.ensureZone("apps.example.com")).resolves.toMatchObject({
      id: "zone-2",
      status: "pending",
      nameServers: ["ns-a.example.net", "ns-b.example.net"],
    });
    const createRequest = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(createRequest[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(createRequest[1].body))).toEqual({
      account: { id: "account-1" },
      name: "apps.example.com",
      type: "full",
    });
  });

  it("service 단위 Named Tunnel을 재사용하고 연결 endpoint를 만든다", async () => {
    const fetcher = vi.fn(async () => apiResponse([
      { id: "12345678-1234-1234-1234-123456789abc", name: "camellia-service-42" },
    ]));
    const client = new CloudflareClient({ ...options, fetcher });

    await expect(client.ensureNamedTunnel("42")).resolves.toEqual({
      id: "12345678-1234-1234-1234-123456789abc",
      name: "camellia-service-42",
      endpoint: "12345678-1234-1234-1234-123456789abc.cfargotunnel.com",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("Named Tunnel이 없으면 원격 관리형으로 생성한다", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(apiResponse([]))
      .mockResolvedValueOnce(apiResponse({
        id: "22345678-1234-1234-1234-123456789abc",
        name: "camellia-service-7",
      }));
    const client = new CloudflareClient({ ...options, fetcher });

    await expect(client.ensureNamedTunnel("7")).resolves.toMatchObject({
      id: "22345678-1234-1234-1234-123456789abc",
    });
    const createRequest = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(createRequest[0]).toContain("/accounts/account-1/cfd_tunnel");
    expect(JSON.parse(String(createRequest[1].body))).toEqual({
      name: "camellia-service-7",
      config_src: "cloudflare",
    });
  });

  it("Tunnel token을 반환하고 API token을 URL에 넣지 않는다", async () => {
    const fetcher = vi.fn(async () => apiResponse("opaque-tunnel-token"));
    const client = new CloudflareClient({ ...options, fetcher });

    await expect(client.getTunnelToken("tunnel-1")).resolves.toBe("opaque-tunnel-token");
    const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(request[0])).not.toContain(options.apiToken);
    expect(new Headers(request[1].headers).get("Authorization"))
      .toBe("Bearer secret-token");
  });

  it("기존 CNAME을 원하는 target으로 변경한다", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(apiResponse([
        {
          id: "dns-1",
          type: "CNAME",
          name: "service-42.example.com",
          content: "old-origin.example.net",
          proxied: true,
        },
      ]))
      .mockResolvedValueOnce(apiResponse({
        id: "dns-1",
        type: "CNAME",
        name: "service-42.example.com",
        content: "new-origin.example.net",
        proxied: true,
      }));
    const client = new CloudflareClient({ ...options, fetcher });

    await expect(client.switchServiceOrigin({
      zoneId: "zone-1",
      serviceHostname: "service-42.example.com",
      originHostname: "new-origin.example.net",
    })).resolves.toMatchObject({ content: "new-origin.example.net", proxied: true });
    const updateRequest = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(updateRequest[1].method).toBe("PATCH");
    expect(JSON.parse(String(updateRequest[1].body))).toMatchObject({
      type: "CNAME",
      content: "new-origin.example.net",
      proxied: true,
    });
  });

  it("CNAME이 없으면 자동 TTL과 Cloudflare proxy로 생성한다", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(apiResponse([]))
      .mockResolvedValueOnce(apiResponse({
        id: "dns-new",
        type: "CNAME",
        name: "candidate-42.example.com",
        content: "tunnel.example.net",
        proxied: true,
      }));
    const client = new CloudflareClient({ ...options, fetcher });

    await expect(client.ensureCname({
      zoneId: "zone-1",
      hostname: "candidate-42.example.com",
      target: "tunnel.example.net",
    })).resolves.toMatchObject({ id: "dns-new", proxied: true });
    const createRequest = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(createRequest[1].method).toBe("POST");
    expect(JSON.parse(String(createRequest[1].body))).toMatchObject({
      type: "CNAME",
      name: "candidate-42.example.com",
      content: "tunnel.example.net",
      ttl: 1,
      proxied: true,
    });
  });

  it("이미 원하는 CNAME이면 DNS 변경 없이 재사용한다", async () => {
    const fetcher = vi.fn(async () => apiResponse([
      {
        id: "dns-existing",
        type: "CNAME",
        name: "service-42.example.com",
        content: "alb.example.net",
        proxied: true,
      },
    ]));
    const client = new CloudflareClient({ ...options, fetcher });

    await expect(client.ensureCname({
      zoneId: "zone-1",
      hostname: "service-42.example.com",
      target: "alb.example.net",
    })).resolves.toMatchObject({ id: "dns-existing", content: "alb.example.net" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("Named Tunnel origin 설정에서 같은 hostname만 교체하고 404 fallback을 유지한다", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(apiResponse({
        config: {
          originRequest: { connectTimeout: 10 },
          ingress: [
            { hostname: "service-42.example.com", service: "http://localhost:3000" },
            { service: "http_status:404" },
          ],
        },
      }))
      .mockResolvedValueOnce(apiResponse({ id: "ok" }));
    const client = new CloudflareClient({ ...options, fetcher });

    await client.setTunnelOrigin({
      tunnelId: "tunnel-1",
      hostname: "service-42.example.com",
      serviceUrl: "http://localhost:49152",
    });
    const updateRequest = fetcher.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(updateRequest[1].body))).toEqual({
      config: {
        originRequest: { connectTimeout: 10 },
        ingress: [
          { hostname: "service-42.example.com", service: "http://localhost:49152" },
          { service: "http_status:404" },
        ],
      },
    });
  });

  it("Cloudflare API error message와 credential을 노출하지 않는다", async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ success: false, errors: [{ code: 10000, message: options.apiToken }] }),
      { status: 403 },
    ));
    const client = new CloudflareClient({ ...options, fetcher });

    const error = await client.ensureZone("apps.example.com").catch((caught) => caught);
    expect(error).toBeInstanceOf(CloudflareApiError);
    expect(error.message).not.toContain(options.apiToken);
    expect(JSON.stringify(error)).not.toContain(options.apiToken);
    expect(error).toMatchObject({ code: "CLOUDFLARE_API_FAILURE", status: 403, cloudflareCode: 10000 });
  });

  it("hostname, origin scheme, service id를 검증한다", async () => {
    expect(tunnelNameForService("42")).toBe("camellia-service-42");
    expect(() => tunnelNameForService("bad service")).toThrow(CloudflareApiError);
    const client = new CloudflareClient({ ...options, fetcher: vi.fn() as typeof fetch });
    await expect(client.setTunnelOrigin({
      tunnelId: "t1",
      hostname: "service-42.example.com",
      serviceUrl: "ftp://localhost:42",
    })).rejects.toMatchObject({ code: "CLOUDFLARE_INVALID_ARGUMENT" });
  });
});
