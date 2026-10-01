import { randomUUID } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { createServer, type Server } from "node:http";
import { dirname } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NodeBackgroundProcessRunner } from "../src/background-process.js";
import type { TunnelSessionProvider } from "../src/contracts.js";
import { CloudflaredTunnelProvider } from "../src/tunnel.js";

type CloudflareEnvelope<T> = {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number }>;
};

type CreatedResource = { id?: string };

const enabled = process.env.RUN_CLOUDFLARE_INTEGRATION === "1";
const apiRoot = "https://api.cloudflare.com/client/v4";
const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? "";
const domain = process.env.DEMO_PLATFORM_DOMAIN ?? "";
const cloudflaredPath = process.env.CLOUDFLARED_PATH ?? "";

async function cloudflareRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(`${apiRoot}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const envelope = (await response.json()) as CloudflareEnvelope<T>;
  if (!response.ok || envelope.success !== true || envelope.result === undefined) {
    throw new Error(
      `Cloudflare API ${response.status}: ${envelope.errors?.[0]?.code ?? "unknown"}`,
    );
  }
  return envelope.result;
}

async function waitForExternalHealth(url: string, hostname: string): Promise<Response> {
  let lastFailure = "unknown";
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    try {
      await resolve4(hostname);
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return response;
      lastFailure = String(response.status);
    } catch (error) {
      const cause = error instanceof Error && "cause" in error
        ? error.cause
        : undefined;
      lastFailure =
        cause && typeof cause === "object" && "code" in cause
          ? String(cause.code)
          : error instanceof Error
            ? error.name
            : "network_error";
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`외부 endpoint 확인 실패: ${lastFailure}`);
}

describe.skipIf(!enabled)("Cloudflare Named Tunnel 실제 통합", () => {
  const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const tunnelName = `camellia-agent-it-${suffix}`;
  const hostname = `${tunnelName}.${domain}`;
  let tunnelId: string | undefined;
  let dnsRecordId: string | undefined;
  let origin: Server | undefined;
  let provider: CloudflaredTunnelProvider | undefined;

  async function cleanup(): Promise<void> {
    await provider?.stop(91).catch(() => undefined);
    provider = undefined;
    if (origin?.listening) {
      await new Promise<void>((resolve) => origin?.close(() => resolve()));
    }
    origin = undefined;
    if (dnsRecordId) {
      await cloudflareRequest(
        `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(dnsRecordId)}`,
        { method: "DELETE" },
      ).catch(() => undefined);
      dnsRecordId = undefined;
    }
    if (tunnelId) {
      const tunnelPath = `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}`;
      await cloudflareRequest(`${tunnelPath}/connections`, {
        method: "DELETE",
      }).catch(() => undefined);
      await cloudflareRequest(tunnelPath, { method: "DELETE" }).catch(
        () => undefined,
      );
      tunnelId = undefined;
    }
  }

  afterAll(cleanup);

  it("동적 localPort를 실제 Tunnel로 노출하고 생성한 리소스를 정리한다", async () => {
    expect(apiToken).not.toBe("");
    expect(accountId).not.toBe("");
    expect(zoneId).not.toBe("");
    expect(domain).not.toBe("");
    expect(cloudflaredPath).not.toBe("");

    origin = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ status: "ok", source: "camellia-agent-provider" }),
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve, reject) => {
      origin?.once("error", reject);
      origin?.listen(0, "127.0.0.1", resolve);
    });
    const address = origin.address();
    if (!address || typeof address === "string") {
      throw new Error("동적 로컬 포트를 확인하지 못했습니다.");
    }
    const localPort = address.port;

    const sessions: TunnelSessionProvider = {
      async prepare(input) {
        expect(input.localPort).toBe(localPort);
        const tunnel = await cloudflareRequest<CreatedResource>(
          `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel`,
          {
            method: "POST",
            body: { name: tunnelName, config_src: "cloudflare" },
          },
        );
        if (!tunnel.id) throw new Error("Tunnel ID가 없습니다.");
        tunnelId = tunnel.id;
        await cloudflareRequest(
          `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`,
          {
            method: "PUT",
            body: {
              config: {
                ingress: [
                  { hostname, service: `http://127.0.0.1:${input.localPort}` },
                  { service: "http_status:404" },
                ],
              },
            },
          },
        );
        const dns = await cloudflareRequest<CreatedResource>(
          `/zones/${encodeURIComponent(zoneId)}/dns_records`,
          {
            method: "POST",
            body: {
              type: "CNAME",
              name: hostname,
              content: `${tunnelId}.cfargotunnel.com`,
              ttl: 1,
              proxied: true,
            },
          },
        );
        if (!dns.id) throw new Error("DNS record ID가 없습니다.");
        dnsRecordId = dns.id;
        const token = await cloudflareRequest<string>(
          `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/token`,
        );
        return { tunnelId, token, hostname };
      },
    };

    provider = new CloudflaredTunnelProvider({
      sessions,
      processes: new NodeBackgroundProcessRunner({ stopTimeoutMs: 5_000 }),
      environment: {
        PATH: `${dirname(cloudflaredPath)}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
      },
    });
    const result = await provider.start({
      jobId: `job-${suffix}`,
      deploymentId: 91,
      environmentId: "cloudflare-live-test",
      localPort,
    });
    expect(result).toEqual({ tunnelId, endpoint: `https://${hostname}` });
    expect(await provider.isRunning(91)).toBe(true);

    // 신규 hostname의 첫 NXDOMAIN 응답이 재귀 DNS에 캐시되지 않도록 전파를 기다린다.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const external = await waitForExternalHealth(
      `${result.endpoint}/health`,
      hostname,
    );
    await expect(external.json()).resolves.toMatchObject({
      status: "ok",
      source: "camellia-agent-provider",
    });

    await cleanup();
    const tunnelMatches = await cloudflareRequest<CreatedResource[]>(
      `/accounts/${encodeURIComponent(accountId)}/cfd_tunnel?${new URLSearchParams({
        name: tunnelName,
        is_deleted: "false",
      })}`,
    );
    const dnsMatches = await cloudflareRequest<CreatedResource[]>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records?${new URLSearchParams({
        name: hostname,
      })}`,
    );
    expect(tunnelMatches).toEqual([]);
    expect(dnsMatches).toEqual([]);
  });
});
