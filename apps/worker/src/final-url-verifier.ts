import {
  buildHealthUrl,
  executeHealthCheck,
  MAX_ATTEMPTS,
  REQUIRED_PASSES,
  RETRY_INTERVAL_MS,
  SUCCESS_INTERVAL_MS,
  type HealthCheckAttempt,
  type VerifyJobPayload,
  type VerifyResult,
  type VerifyRuntime,
} from "./handlers/verify.js";

export type FinalUrlVerificationInput = Pick<
  VerifyJobPayload,
  "deploymentId" | "environmentId" | "health"
> & {
  serviceHostname: string;
};

export type FinalUrlVerifierOptions = {
  protocol?: "https" | "http";
};

export class FinalUrlVerifier {
  private readonly protocol: "https" | "http";

  constructor(options: FinalUrlVerifierOptions = {}) {
    this.protocol = options.protocol ?? "https";
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
