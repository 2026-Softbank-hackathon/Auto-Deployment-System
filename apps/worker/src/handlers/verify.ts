import { z } from "zod";
import type { WorkerDeps } from "../deps.js";

const REQUIRED_PASSES = 3 as const;
const MAX_ATTEMPTS = 8;
const RETRY_INTERVAL_MS = 5_000;

export const VerifyJobPayloadSchema = z.object({
  jobId: z.string().min(1),
  attempt: z.number().int().min(1),
  deploymentId: z.number().int().positive(),
  environmentId: z.string().min(1),
  environmentType: z.enum(["aws", "onprem"]),
  serviceId: z.string().min(1),
  targetUrl: z.string().url(),
  health: z.object({
    path: z.string().min(1),
    expectedStatus: z.number().int().min(100).max(599),
    timeoutMs: z.number().int().positive(),
  }),
  expectedDigest: z.string().min(1).optional(),
});

export type VerifyJobPayload = z.infer<typeof VerifyJobPayloadSchema>;

export type HealthCheckAttempt = {
  attempt: number;
  timestamp: string;
  statusCode?: number;
  latencyMs?: number;
  passed: boolean;
  error?: string;
};

export type VerifyResult = {
  deploymentId: number;
  environmentId: string;
  status: "passed" | "failed";
  targetUrl: string;
  checks: HealthCheckAttempt[];
  consecutivePassed: number;
  requiredPasses: typeof REQUIRED_PASSES;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  failureReason?: string;
};

export type VerifyRuntime = {
  sleep: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  onAttempt?: (attempt: HealthCheckAttempt) => Promise<void>;
};

const defaultRuntime: VerifyRuntime = {
  sleep: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export async function handleVerify(
  job: { data: VerifyJobPayload },
  deps: WorkerDeps,
  runtime: VerifyRuntime = defaultRuntime,
): Promise<VerifyResult> {
  const startedAt = new Date();
  const parsed = VerifyJobPayloadSchema.safeParse(job.data);
  if (!parsed.success) {
    return failedBeforeChecks(job.data, startedAt, "validation_error");
  }

  const payload = parsed.data;
  let healthUrl: string;
  try {
    healthUrl = buildHealthUrl(payload.targetUrl, payload.health.path);
  } catch {
    return failedBeforeChecks(payload, startedAt, "invalid_health_url");
  }

  if (runtime.signal?.aborted) {
    return failedBeforeChecks(payload, startedAt, "cancelled", healthUrl);
  }

  const deployment = await deps.pool.query<{ status: string }>(
    "SELECT status FROM deployments WHERE id = $1",
    [payload.deploymentId],
  );
  if (deployment.rows[0]?.status !== "verifying") {
    return failedBeforeChecks(
      payload,
      startedAt,
      "deployment_not_verifying",
      healthUrl,
    );
  }

  deps.log?.info(
    {
      deploymentId: payload.deploymentId,
      environmentId: payload.environmentId,
      environmentType: payload.environmentType,
    },
    "verify job started",
  );

  const checks: HealthCheckAttempt[] = [];
  let consecutivePassed = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (runtime.signal?.aborted) {
      return finishResult(
        payload,
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
      payload.health.expectedStatus,
      payload.health.timeoutMs,
      attempt,
      runtime.signal,
    );
    checks.push(check);
    await runtime.onAttempt?.(check);
    consecutivePassed = check.passed ? consecutivePassed + 1 : 0;

    deps.log?.info(
      {
        deploymentId: payload.deploymentId,
        environmentId: payload.environmentId,
        attempt,
        statusCode: check.statusCode,
        latencyMs: check.latencyMs,
        passed: check.passed,
        error: check.error,
      },
      "verify health check completed",
    );

    if (consecutivePassed === REQUIRED_PASSES) {
      return finishResult(
        payload,
        healthUrl,
        checks,
        consecutivePassed,
        startedAt,
        "passed",
      );
    }

    if (runtime.signal?.aborted || check.error === "cancelled") {
      return finishResult(
        payload,
        healthUrl,
        checks,
        consecutivePassed,
        startedAt,
        "failed",
        "cancelled",
      );
    }

    if (attempt < MAX_ATTEMPTS) {
      await runtime.sleep(RETRY_INTERVAL_MS);
    }
  }

  return finishResult(
    payload,
    healthUrl,
    checks,
    consecutivePassed,
    startedAt,
    "failed",
    checks.at(-1)?.error ?? "max_attempts_exceeded",
  );
}

async function executeHealthCheck(
  targetUrl: string,
  expectedStatus: number,
  timeoutMs: number,
  attempt: number,
  externalSignal?: AbortSignal,
): Promise<HealthCheckAttempt> {
  const timestamp = new Date();
  const requestStartedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const cancelRequest = () => controller.abort();
  externalSignal?.addEventListener("abort", cancelRequest, { once: true });

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    });
    const latencyMs = Date.now() - requestStartedAt;
    const passed = response.status === expectedStatus;
    return {
      attempt,
      timestamp: timestamp.toISOString(),
      statusCode: response.status,
      latencyMs,
      passed,
      ...(!passed
        ? {
            error: `unexpected_status: expected ${expectedStatus}, received ${response.status}`,
          }
        : {}),
    };
  } catch (error) {
    return {
      attempt,
      timestamp: timestamp.toISOString(),
      latencyMs: Date.now() - requestStartedAt,
      passed: false,
      error: classifyRequestError(error, timedOut, externalSignal?.aborted),
    };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", cancelRequest);
  }
}

function buildHealthUrl(targetUrl: string, healthPath: string): string {
  const base = new URL(targetUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("unsupported protocol");
  }
  if (base.username || base.password) {
    throw new Error("userinfo is not allowed");
  }
  if (!healthPath.startsWith("/") || healthPath.startsWith("//")) {
    throw new Error("health path must be origin-relative");
  }

  const healthUrl = new URL(healthPath, base);
  if (healthUrl.origin !== base.origin) {
    throw new Error("health path changed origin");
  }
  healthUrl.hash = "";
  return healthUrl.toString();
}

function classifyRequestError(
  error: unknown,
  timedOut: boolean,
  cancelled = false,
): string {
  if (timedOut) return "timeout";
  if (cancelled) return "cancelled";

  const code = extractErrorCode(error);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns_error";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (code.startsWith("CERT_") || code.includes("TLS")) return "tls_error";
  return "network_error";
}

function extractErrorCode(error: unknown): string {
  if (error === null || typeof error !== "object") return "";
  const directCode = Reflect.get(error, "code");
  if (typeof directCode === "string") return directCode;
  const cause = Reflect.get(error, "cause");
  if (cause !== null && typeof cause === "object") {
    const causeCode = Reflect.get(cause, "code");
    if (typeof causeCode === "string") return causeCode;
  }
  return "";
}

function finishResult(
  payload: Pick<VerifyJobPayload, "deploymentId" | "environmentId">,
  targetUrl: string,
  checks: HealthCheckAttempt[],
  consecutivePassed: number,
  startedAt: Date,
  status: VerifyResult["status"],
  failureReason?: string,
): VerifyResult {
  const finishedAt = new Date();
  return {
    deploymentId: payload.deploymentId,
    environmentId: payload.environmentId,
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

function failedBeforeChecks(
  payload: Partial<VerifyJobPayload>,
  startedAt: Date,
  failureReason: string,
  targetUrl = typeof payload.targetUrl === "string" ? payload.targetUrl : "",
): VerifyResult {
  return finishResult(
    {
      deploymentId:
        typeof payload.deploymentId === "number" ? payload.deploymentId : 0,
      environmentId:
        typeof payload.environmentId === "string" ? payload.environmentId : "",
    },
    targetUrl,
    [],
    0,
    startedAt,
    "failed",
    failureReason,
  );
}
