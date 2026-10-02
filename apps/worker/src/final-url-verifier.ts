import { isIP } from "node:net";
import {
  buildHealthUrl,
  executeHealthCheck,
  MAX_ATTEMPTS,
  REQUIRED_PASSES,
  RETRY_INTERVAL_MS,
  SUCCESS_INTERVAL_MS,
  type HealthCheckAttempt,
  type HostAddressLookup,
  type VerifyJobPayload,
  type VerifyResult,
  type VerifyRuntime,
} from "./handlers/verify.js";
import {
  AuthoritativeDnsResolver,
  PublicDnsActivationChecker,
  type DnsResolver,
} from "./public-dns-activation.js";

export type FinalUrlVerificationInput = Pick<
  VerifyJobPayload,
  "deploymentId" | "environmentId" | "health"
> & {
  serviceHostname: string;
};

export type FinalUrlVerifierOptions = {
  protocol?: "https" | "http";
  resolver?: DnsResolver;
  dnsWaitAttempts?: number;
  dnsWaitIntervalMs?: number;
};

// 레코드가 권한 DNS 에 보일 때까지 최대 약 60초 기다린 뒤 헬스체크를 시작한다.
const DEFAULT_DNS_WAIT_ATTEMPTS = 30;
const DEFAULT_DNS_WAIT_INTERVAL_MS = 2_000;

export class FinalUrlVerifier {
  private readonly protocol: "https" | "http";
  private readonly resolver: DnsResolver;
  private readonly dnsWaitAttempts: number;
  private readonly dnsWaitIntervalMs: number;

  constructor(options: FinalUrlVerifierOptions = {}) {
    this.protocol = options.protocol ?? "https";
    this.resolver = options.resolver ?? new AuthoritativeDnsResolver();
    this.dnsWaitAttempts = options.dnsWaitAttempts ?? DEFAULT_DNS_WAIT_ATTEMPTS;
    this.dnsWaitIntervalMs =
      options.dnsWaitIntervalMs ?? DEFAULT_DNS_WAIT_INTERVAL_MS;
  }

  async verify(
    input: FinalUrlVerificationInput,
    runtime: VerifyRuntime,
  ): Promise<VerifyResult> {
    const startedAt = new Date();
    const healthUrl = buildHealthUrl(
      this.serviceBaseUrl(input.serviceHostname),
      input.health.path,
    );
    const checks: HealthCheckAttempt[] = [];
    let consecutivePassed = 0;
    // 새 앱의 서비스 레코드는 방금 만들어졌다. 시스템 resolver 는 그 전의
    // NXDOMAIN 을 캐시하고 있을 수 있어 권한 DNS 로 주소를 찾아 접속한다.
    const hostname = new URL(healthUrl).hostname;
    const lookupAddress = isIP(hostname) ? undefined : this.lookupAddress;
    if (lookupAddress) {
      await new PublicDnsActivationChecker({
        attempts: this.dnsWaitAttempts,
        intervalMs: this.dnsWaitIntervalMs,
        resolver: this.resolver,
        sleep: (milliseconds) => runtime.sleep(milliseconds),
      }).waitUntilResolvable(hostname, runtime.signal);
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (runtime.signal?.aborted) {
        return this.result(
          input,
          healthUrl,
          checks,
          consecutivePassed,
          startedAt,
          "failed",
          "cancelled",
        );
      }

      const check = await executeHealthCheck(
        healthUrl,
        input.health.expectedStatus,
        input.health.timeoutMs,
        attempt,
        runtime.signal,
        lookupAddress,
      );
      checks.push(check);
      await runtime.onAttempt?.(check);
      consecutivePassed = check.passed ? consecutivePassed + 1 : 0;

      if (consecutivePassed === REQUIRED_PASSES) {
        return this.result(
          input,
          healthUrl,
          checks,
          consecutivePassed,
          startedAt,
          "passed",
        );
      }
      if (runtime.signal?.aborted || check.error === "cancelled") {
        return this.result(
          input,
          healthUrl,
          checks,
          consecutivePassed,
          startedAt,
          "failed",
          "cancelled",
        );
      }
      if (attempt < MAX_ATTEMPTS) {
        await runtime.sleep(
          check.passed ? SUCCESS_INTERVAL_MS : RETRY_INTERVAL_MS,
        );
      }
    }

    return this.result(
      input,
      healthUrl,
      checks,
      consecutivePassed,
      startedAt,
      "failed",
      checks.at(-1)?.error ?? "max_attempts_exceeded",
    );
  }

  private readonly lookupAddress: HostAddressLookup = async (hostname) => {
    const [address] = await this.resolver.resolve4(hostname);
    if (!address) {
      throw Object.assign(new Error(`no address for ${hostname}`), {
        code: "ENOTFOUND",
      });
    }
    return address;
  };

  private serviceBaseUrl(serviceHostname: string): string {
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i.test(serviceHostname)) {
      throw new Error("FINAL_URL_HOSTNAME_INVALID");
    }
    try {
      const url = new URL(`${this.protocol}://${serviceHostname}`);
      if (
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        url.host.toLowerCase() !== serviceHostname.toLowerCase()
      ) {
        throw new Error();
      }
      return url.toString();
    } catch {
      throw new Error("FINAL_URL_HOSTNAME_INVALID");
    }
  }

  private result(
    input: FinalUrlVerificationInput,
    targetUrl: string,
    checks: HealthCheckAttempt[],
    consecutivePassed: number,
    startedAt: Date,
    status: VerifyResult["status"],
    failureReason?: string,
  ): VerifyResult {
    const finishedAt = new Date();
    return {
      deploymentId: input.deploymentId,
      environmentId: input.environmentId,
      status,
      targetUrl,
      checks,
      consecutivePassed,
      requiredPasses: REQUIRED_PASSES,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      ...(failureReason ? { failureReason } : {}),
    };
  }
}
