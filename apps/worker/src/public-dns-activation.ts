import { Resolver } from "node:dns/promises";

export type DnsResolver = {
  resolve4(hostname: string): Promise<readonly string[]>;
};

type BootstrapResolver = DnsResolver & {
  resolveNs(hostname: string): Promise<readonly string[]>;
};

type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export type PublicDnsActivationCheckerOptions = {
  attempts?: number;
  intervalMs?: number;
  resolver?: DnsResolver;
  sleep?: Sleep;
};

// Resolver timeout(500ms) + interval(250ms) 기준 최악에도 약 15초 안에 끝난다.
const DEFAULT_ATTEMPTS = 20;
const DEFAULT_INTERVAL_MS = 250;
const PUBLIC_DNS_SERVERS = ["1.1.1.1"];

export class PublicDnsActivationChecker {
  private readonly attempts: number;
  private readonly intervalMs: number;
  private readonly resolver: DnsResolver;
  private readonly sleep: Sleep;

  constructor(options: PublicDnsActivationCheckerOptions = {}) {
    this.attempts = options.attempts ?? DEFAULT_ATTEMPTS;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.resolver = options.resolver ?? createPublicResolver();
    this.sleep = options.sleep ?? wait;
  }

  async waitUntilResolvable(
    hostname: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      if (signal?.aborted) return false;
      try {
        const addresses = await this.resolver.resolve4(hostname);
        if (addresses.length > 0) return true;
      } catch {
        // Public DNS에 아직 레코드가 보이지 않으면 짧게 재시도한다.
      }
      if (attempt < this.attempts) {
        await this.sleep(this.intervalMs, signal);
      }
    }
    return false;
  }
}

const FALLBACK_DNS_SERVERS = ["1.1.1.1", "1.0.0.1"];

export type AuthoritativeDnsResolverOptions = {
  bootstrap?: BootstrapResolver;
  createResolver?: (servers: string[]) => DnsResolver;
};

/**
 * 레코드가 있는 zone 의 권한 네임서버에 직접 묻는다.
 * 캐시 resolver(VPC resolver, 1.1.1.1 등)는 레코드가 생기기 전의 NXDOMAIN 을
 * SOA 음수 TTL(Cloudflare 30분) 동안 들고 있어, 막 만든 레코드를 못 볼 수 있다.
 * 네임서버를 못 찾으면 Cloudflare 공개 resolver 로 대신 묻는다.
 */
export class AuthoritativeDnsResolver implements DnsResolver {
  private readonly bootstrap: BootstrapResolver;
  private readonly createResolver: (servers: string[]) => DnsResolver;
  private readonly zoneServers = new Map<string, string[]>();

  constructor(options: AuthoritativeDnsResolverOptions = {}) {
    this.bootstrap = options.bootstrap ?? createResolver(FALLBACK_DNS_SERVERS);
    this.createResolver = options.createResolver ?? createResolver;
  }

  async resolve4(hostname: string): Promise<readonly string[]> {
    const servers = await this.authoritativeServers(hostname);
    return this.createResolver(servers).resolve4(hostname);
  }

  private async authoritativeServers(hostname: string): Promise<string[]> {
    const labels = hostname.toLowerCase().replace(/\.$/, "").split(".");
    // TLD 바로 아래까지 올라가며 NS 가 있는 zone 을 찾는다.
    for (let index = 1; index < labels.length - 1; index += 1) {
      const zone = labels.slice(index).join(".");
      const cached = this.zoneServers.get(zone);
      if (cached) return cached;
      const servers = await this.nameServerAddresses(zone);
      if (servers.length > 0) {
        this.zoneServers.set(zone, servers);
        return servers;
      }
    }
    return FALLBACK_DNS_SERVERS;
  }

  private async nameServerAddresses(zone: string): Promise<string[]> {
    let nameServers: readonly string[];
    try {
      nameServers = await this.bootstrap.resolveNs(zone);
    } catch {
      return [];
    }
    const addresses = await Promise.allSettled(
      nameServers.map((nameServer) => this.bootstrap.resolve4(nameServer)),
    );
    return addresses.flatMap((result) =>
      result.status === "fulfilled" ? [...result.value] : []
    );
  }
}

function createResolver(servers: string[]): Resolver {
  const resolver = new Resolver({ timeout: 1_000, tries: 2 });
  resolver.setServers(servers);
  return resolver;
}

function createPublicResolver(): DnsResolver {
  const resolver = new Resolver({ timeout: 500, tries: 1 });
  resolver.setServers(PUBLIC_DNS_SERVERS);
  return resolver;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
