import { CloudflareApiError } from "./errors.js";

const API_ROOT = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 100;

type ApiEnvelope<T> = {
  success?: boolean;
  result?: T;
  errors?: Array<{ code?: number }>;
  result_info?: { total_pages?: number };
};

export type CloudflareClientOptions = {
  accountId: string;
  apiToken: string;
  fetcher?: typeof fetch;
  apiRoot?: string;
};

export type CloudflareZone = {
  id: string;
  name: string;
  status: string;
  nameServers: string[];
};

export type CloudflareTunnel = {
  id: string;
  name: string;
  endpoint: string;
};

export type CloudflareDnsRecord = {
  id: string;
  name: string;
  content: string;
  proxied: boolean;
};

export type CloudflareTunnelOriginChange = {
  previousServiceUrl: string | null;
};

type ZoneRecord = {
  id?: string;
  name?: string;
  status?: string;
  name_servers?: string[];
  account?: { id?: string };
};

type TunnelRecord = {
  id?: string;
  name?: string;
};

type DnsRecord = {
  id?: string;
  name?: string;
  type?: string;
  content?: string;
  proxied?: boolean;
};

export class CloudflareClient {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly fetcher: typeof fetch;
  private readonly apiRoot: string;

  constructor(options: CloudflareClientOptions) {
    this.accountId = requireValue(options.accountId, "accountId");
    this.apiToken = requireValue(options.apiToken, "apiToken");
    this.fetcher = options.fetcher ?? fetch;
    this.apiRoot = (options.apiRoot ?? API_ROOT).replace(/\/$/, "");
  }

  async ensureZone(zoneName: string): Promise<CloudflareZone> {
    const name = normalizeDomain(zoneName);
    const existing = await this.findZone(name);
    if (existing) return normalizeZone(existing);

    try {
      const created = await this.request<ZoneRecord>("/zones", {
        method: "POST",
        body: { account: { id: this.accountId }, name, type: "full" },
      });
      return normalizeZone(created);
    } catch (error) {
      const raced = await this.findZone(name).catch(() => null);
      if (raced) return normalizeZone(raced);
      throw error;
    }
  }

  async ensureNamedTunnel(serviceId: string): Promise<CloudflareTunnel> {
    const name = tunnelNameForService(serviceId);
    const existing = await this.findTunnel(name);
    if (existing) return normalizeTunnel(existing);

    try {
      const created = await this.request<TunnelRecord>(
        `/accounts/${encodeURIComponent(this.accountId)}/cfd_tunnel`,
        { method: "POST", body: { name, config_src: "cloudflare" } },
      );
      return normalizeTunnel(created);
    } catch (error) {
      const raced = await this.findTunnel(name).catch(() => null);
      if (raced) return normalizeTunnel(raced);
      throw error;
    }
  }

  async getTunnelToken(tunnelId: string): Promise<string> {
    const id = requireValue(tunnelId, "tunnelId");
    const token = await this.request<string>(
      `/accounts/${encodeURIComponent(this.accountId)}/cfd_tunnel/${encodeURIComponent(id)}/token`,
    );
    if (typeof token !== "string" || token.trim().length === 0) {
      throw invalidResponse();
    }
    return token;
  }

  async setTunnelOrigin(input: {
    tunnelId: string;
    hostname: string;
    serviceUrl: string;
  }): Promise<CloudflareTunnelOriginChange> {
    const tunnelId = requireValue(input.tunnelId, "tunnelId");
    const hostname = normalizeDomain(input.hostname);
    const serviceUrl = normalizeServiceUrl(input.serviceUrl);
    const path = `/accounts/${encodeURIComponent(this.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`;
    const current = await this.request<{
      config?: {
        ingress?: Array<Record<string, unknown>>;
        [key: string]: unknown;
      };
    }>(path);
    const currentIngress = current.config?.ingress ?? [];
    const previousRule = currentIngress.find(
      (rule) => rule.hostname === hostname,
    );
    const previousServiceUrl = typeof previousRule?.service === "string"
      ? previousRule.service
      : null;
    const ingress = currentIngress.filter(
      (rule) => rule.hostname !== hostname && rule.service !== "http_status:404",
    );
    ingress.push({ hostname, service: serviceUrl });
    ingress.push({ service: "http_status:404" });
    await this.request(path, {
      method: "PUT",
      body: { config: { ...current.config, ingress } },
    });
    return { previousServiceUrl };
  }

  async removeTunnelOrigin(input: {
    tunnelId: string;
    hostname: string;
    expectedServiceUrl: string;
  }): Promise<void> {
    const tunnelId = requireValue(input.tunnelId, "tunnelId");
    const hostname = normalizeDomain(input.hostname);
    const expectedServiceUrl = normalizeServiceUrl(input.expectedServiceUrl);
    const path = `/accounts/${encodeURIComponent(this.accountId)}/cfd_tunnel/${encodeURIComponent(tunnelId)}/configurations`;
    const current = await this.request<{
      config?: {
        ingress?: Array<Record<string, unknown>>;
        [key: string]: unknown;
      };
    }>(path);
    const currentIngress = current.config?.ingress ?? [];
    const currentRule = currentIngress.find((rule) => rule.hostname === hostname);
    if (!currentRule) return;
    if (currentRule.service !== expectedServiceUrl) {
      throw new CloudflareApiError(
        "CLOUDFLARE_INVALID_ARGUMENT",
        "현재 Tunnel origin이 예상값과 달라 삭제하지 않았습니다.",
      );
    }
    const ingress = currentIngress.filter(
      (rule) => rule.hostname !== hostname && rule.service !== "http_status:404",
    );
    ingress.push({ service: "http_status:404" });
    await this.request(path, {
      method: "PUT",
      body: { config: { ...current.config, ingress } },
    });
  }

  async getCname(input: {
    zoneId: string;
    hostname: string;
  }): Promise<CloudflareDnsRecord | null> {
    const zoneId = requireValue(input.zoneId, "zoneId");
    const hostname = normalizeDomain(input.hostname);
    const path = `/zones/${encodeURIComponent(zoneId)}/dns_records`;
    const matches = await this.request<DnsRecord[]>(
      `${path}?${new URLSearchParams({
        type: "CNAME",
        name: hostname,
        per_page: String(PAGE_SIZE),
      })}`,
    );
    const existing = matches.find(
      (record) => record.type === "CNAME" && record.name === hostname,
    );
    return existing ? normalizeDnsRecord(existing) : null;
  }

  async deleteCname(input: {
    zoneId: string;
    hostname: string;
    expectedTarget: string;
  }): Promise<void> {
    const zoneId = requireValue(input.zoneId, "zoneId");
    const hostname = normalizeDomain(input.hostname);
    const expectedTarget = normalizeDomain(input.expectedTarget);
    const existing = await this.getCname({ zoneId, hostname });
    if (!existing) return;
    if (existing.content !== expectedTarget) {
      throw new CloudflareApiError(
        "CLOUDFLARE_INVALID_ARGUMENT",
        "현재 CNAME target이 예상값과 달라 삭제하지 않았습니다.",
      );
    }
    await this.request<{ id?: string }>(
      `/zones/${encodeURIComponent(zoneId)}/dns_records/${encodeURIComponent(existing.id)}`,
      { method: "DELETE" },
    );
  }

  async ensureCname(input: {
    zoneId: string;
    hostname: string;
    target: string;
    proxied?: boolean;
  }): Promise<CloudflareDnsRecord> {
    const zoneId = requireValue(input.zoneId, "zoneId");
    const hostname = normalizeDomain(input.hostname);
    const target = normalizeDomain(input.target);
    const proxied = input.proxied ?? true;
    const path = `/zones/${encodeURIComponent(zoneId)}/dns_records`;
    const matches = await this.request<DnsRecord[]>(
      `${path}?${new URLSearchParams({
        type: "CNAME",
        name: hostname,
        per_page: String(PAGE_SIZE),
      })}`,
    );
    const existing = matches.find(
      (record) => record.type === "CNAME" && record.name === hostname,
    );

    if (existing?.id) {
      if (existing.content === target && existing.proxied === proxied) {
        return normalizeDnsRecord(existing);
      }
      const updated = await this.request<DnsRecord>(
        `${path}/${encodeURIComponent(existing.id)}`,
        {
          method: "PATCH",
          body: { type: "CNAME", name: hostname, content: target, ttl: 1, proxied },
        },
      );
      return normalizeDnsRecord(updated);
    }

    const created = await this.request<DnsRecord>(path, {
      method: "POST",
      body: { type: "CNAME", name: hostname, content: target, ttl: 1, proxied },
    });
    return normalizeDnsRecord(created);
  }

  async switchServiceOrigin(input: {
    zoneId: string;
    serviceHostname: string;
    originHostname: string;
  }): Promise<CloudflareDnsRecord> {
    return this.ensureCname({
      zoneId: input.zoneId,
      hostname: input.serviceHostname,
      target: input.originHostname,
      proxied: true,
    });
  }

  private async findZone(name: string): Promise<ZoneRecord | null> {
    const query = new URLSearchParams({
      name,
      "account.id": this.accountId,
      page: "1",
      per_page: "50",
    });
    const zones = await this.request<ZoneRecord[]>(`/zones?${query}`);
    return zones.find(
      (zone) => zone.name === name && zone.account?.id === this.accountId,
    ) ?? null;
  }

  private async findTunnel(name: string): Promise<TunnelRecord | null> {
    const query = new URLSearchParams({ name, page: "1", per_page: "100" });
    const tunnels = await this.request<TunnelRecord[]>(
      `/accounts/${encodeURIComponent(this.accountId)}/cfd_tunnel?${query}`,
    );
    return tunnels.find((tunnel) => tunnel.name === name) ?? null;
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.apiRoot}${path}`, {
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      });
    } catch {
      throw new CloudflareApiError(
        "CLOUDFLARE_API_FAILURE",
        "Cloudflare API에 연결하지 못했습니다.",
      );
    }

    let envelope: ApiEnvelope<T>;
    try {
      envelope = (await response.json()) as ApiEnvelope<T>;
    } catch {
      throw new CloudflareApiError(
        "CLOUDFLARE_INVALID_RESPONSE",
        "Cloudflare API 응답을 읽지 못했습니다.",
        { status: response.status },
      );
    }

    if (!response.ok || envelope.success !== true) {
      throw new CloudflareApiError(
        "CLOUDFLARE_API_FAILURE",
        "Cloudflare API 요청이 실패했습니다.",
        {
          status: response.status,
          cloudflareCode: envelope.errors?.[0]?.code,
        },
      );
    }
    if (envelope.result === undefined) throw invalidResponse(response.status);
    return envelope.result;
  }
}

export function tunnelNameForService(serviceId: string): string {
  const id = requireValue(serviceId, "serviceId");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(id)) {
    throw new CloudflareApiError(
      "CLOUDFLARE_INVALID_ARGUMENT",
      "serviceId 형식이 올바르지 않습니다.",
    );
  }
  return `camellia-service-${id}`;
}

function normalizeZone(zone: ZoneRecord): CloudflareZone {
  if (!zone.id || !zone.name || !zone.status) throw invalidResponse();
  return {
    id: zone.id,
    name: zone.name,
    status: zone.status,
    nameServers: zone.name_servers ?? [],
  };
}

function normalizeTunnel(tunnel: TunnelRecord): CloudflareTunnel {
  if (!tunnel.id || !tunnel.name) throw invalidResponse();
  return {
    id: tunnel.id,
    name: tunnel.name,
    endpoint: `${tunnel.id}.cfargotunnel.com`,
  };
}

function normalizeDnsRecord(record: DnsRecord): CloudflareDnsRecord {
  if (
    !record.id ||
    !record.name ||
    !record.content ||
    typeof record.proxied !== "boolean"
  ) {
    throw invalidResponse();
  }
  return {
    id: record.id,
    name: record.name,
    content: record.content,
    proxied: record.proxied,
  };
}

function normalizeDomain(value: string): string {
  const domain = requireValue(value, "domain").replace(/\.$/, "").toLowerCase();
  if (
    domain.length > 253 ||
    !domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new CloudflareApiError(
      "CLOUDFLARE_INVALID_ARGUMENT",
      "유효한 DNS 이름이 필요합니다.",
    );
  }
  return domain;
}

function normalizeServiceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudflareApiError(
      "CLOUDFLARE_INVALID_ARGUMENT",
      "유효한 Tunnel origin URL이 필요합니다.",
    );
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new CloudflareApiError(
      "CLOUDFLARE_INVALID_ARGUMENT",
      "Tunnel origin은 HTTP 또는 HTTPS URL이어야 합니다.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function requireValue(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new CloudflareApiError(
      "CLOUDFLARE_INVALID_ARGUMENT",
      `${field} 값이 필요합니다.`,
    );
  }
  return normalized;
}

function invalidResponse(status?: number): CloudflareApiError {
  return new CloudflareApiError(
    "CLOUDFLARE_INVALID_RESPONSE",
    "Cloudflare API 응답 형식이 올바르지 않습니다.",
    status === undefined ? {} : { status },
  );
}
