import { Resolver } from "node:dns/promises";

type DnsResolver = {
  resolve4(hostname: string): Promise<readonly string[]>;
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
