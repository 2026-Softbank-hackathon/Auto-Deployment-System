import type { Pool } from "@camellia/db";
import type { DeploymentHealth } from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";

type DeploymentRow = {
  id: number;
  status: string;
  public_url: string | null;
};

type VerifyStepRow = {
  id: number;
  status: "running" | "succeeded" | "failed";
  message: string | null;
};

type HealthCheckAttemptRow = {
  attempt: number;
  checked_at: Date;
  status_code: number | null;
  latency_ms: number | null;
  passed: boolean;
  error_code: string | null;
  error_message: string | null;
};

type VerificationPhase = "target" | "origin_switching" | "public_url";

export type DeploymentHealthResponse = DeploymentHealth;

export class DeploymentHealthService {
  constructor(private readonly pool: Pool) {}

  async get(deploymentId: number): Promise<DeploymentHealthResponse> {
    const deploymentResult = await this.pool.query<DeploymentRow>(
      `SELECT id, status, public_url
       FROM deployments
       WHERE id = $1`,
      [deploymentId],
    );
    const deployment = deploymentResult.rows[0];
    if (!deployment) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        `배포 ID ${deploymentId}를 찾을 수 없습니다.`,
      );
    }

    const stepResult = await this.pool.query<VerifyStepRow>(
      `SELECT id, status, message
       FROM deployment_steps
       WHERE deployment_id = $1 AND step_name = 'verify'
       ORDER BY id DESC
       LIMIT 1`,
      [deploymentId],
    );
    const step = stepResult.rows[0];
    if (!step) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        `배포 ID ${deploymentId}의 검증 기록을 찾을 수 없습니다.`,
      );
    }

    const phase = readPhase(step.message);
    const attemptPhase = phase === "public_url" ? "public_url" : "target";

    const attemptsResult = await this.pool.query<HealthCheckAttemptRow>(
      `SELECT attempt, checked_at, status_code, latency_ms, passed,
              error_code, error_message
       FROM health_check_attempts
       WHERE deployment_step_id = $1 AND phase = $2
       ORDER BY attempt ASC`,
      [step.id, attemptPhase],
    );

    const checks = attemptsResult.rows.map((row) => {
      const error = row.error_code ?? row.error_message;
      return {
        attempt: row.attempt,
        timestamp: row.checked_at.toISOString(),
        ...(row.status_code !== null ? { statusCode: row.status_code } : {}),
        ...(row.latency_ms !== null ? { latencyMs: row.latency_ms } : {}),
        passed: row.passed,
        ...(error ? { error } : {}),
      };
    });

    return {
      deploymentId: String(deploymentId),
      status: mapStepStatus(step.status),
      phase,
      checks,
      consecutivePassed: countConsecutivePasses(attemptsResult.rows),
      requiredPasses: 3,
      targetUrl:
        readTargetUrl(step.message) ??
        buildDefaultHealthUrl(deployment.public_url),
    };
  }
}

function readPhase(message: string | null | undefined): VerificationPhase {
  if (!message) return "target";
  try {
    const parsed: unknown = JSON.parse(message);
    if (parsed === null || typeof parsed !== "object") return "target";
    const phase = Reflect.get(parsed, "phase");
    if (
      phase === "target" ||
      phase === "origin_switching" ||
      phase === "public_url"
    ) {
      return phase;
    }
  } catch {
    // 과거의 일반 문자열 message는 target 검증 기록으로 취급한다.
  }
  return "target";
}

function mapStepStatus(
  status: VerifyStepRow["status"],
): DeploymentHealthResponse["status"] {
  if (status === "running") return "checking";
  if (status === "succeeded") return "passed";
  return "failed";
}

function countConsecutivePasses(rows: HealthCheckAttemptRow[]): number {
  let count = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (!rows[index]?.passed) break;
    count += 1;
  }
  return count;
}

function buildDefaultHealthUrl(publicUrl: string | null): string {
  if (!publicUrl) return "";
  const url = new URL(publicUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/health`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function readTargetUrl(message: string | null | undefined): string | null {
  if (!message) return null;
  try {
    const parsed: unknown = JSON.parse(message);
    if (parsed === null || typeof parsed !== "object") return null;
    const targetUrl = Reflect.get(parsed, "targetUrl");
    return typeof targetUrl === "string" ? targetUrl : null;
  } catch {
    return null;
  }
}
