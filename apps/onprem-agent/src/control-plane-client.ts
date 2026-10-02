import type {
  AgentControlPlaneClient,
  AgentJobHeartbeatResult,
  AgentRuntimeReport,
  EcrCredential,
  OnpremAgentJob,
  OnpremCleanupJob,
  OnpremCleanupResult,
  OnpremExecutionResult,
  TunnelSession,
  TunnelStartInput,
} from "./contracts.js";
import type { AgentCredential } from "./credential-store.js";
import { parseOnpremAgentJob, parseOnpremCleanupJob } from "./validation.js";

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("Control Plane 응답 형식이 올바르지 않습니다.");
  }
}

function validateCredential(value: unknown): EcrCredential {
  if (
    !isRecord(value) ||
    typeof value.registry !== "string" ||
    value.username !== "AWS" ||
    typeof value.password !== "string" ||
    typeof value.expiresAt !== "string"
  ) {
    throw new Error("ECR 인증 응답 형식이 올바르지 않습니다.");
  }
  return value as EcrCredential;
}

function validateTunnelSession(value: unknown): TunnelSession {
  if (
    !isRecord(value) ||
    typeof value.tunnelId !== "string" ||
    typeof value.token !== "string" ||
    typeof value.hostname !== "string"
  ) {
    throw new Error("Tunnel 준비 응답 형식이 올바르지 않습니다.");
  }
  return value as TunnelSession;
}

export class AgentControlPlaneHttpClient implements AgentControlPlaneClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly credential: AgentCredential,
    private readonly fetchRequest: Fetch = fetch,
    options: { requestTimeoutMs?: number } = {},
  ) {
    this.baseUrl = credential.controlPlaneUrl.replace(/\/$/, "");
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  async claimCleanupJob(): Promise<OnpremCleanupJob | null> {
    const body = await this.requestJson("/api/v1/agents/cleanup-jobs/claim", {});
    if (!isRecord(body) || !("job" in body)) {
      throw new Error("Cleanup Job claim 응답 형식이 올바르지 않습니다.");
    }
    if (body.job === null) return null;
    return parseOnpremCleanupJob(body.job);
  }

  async claimJob(): Promise<OnpremAgentJob | null> {
    const body = await this.requestJson("/api/v1/agents/jobs/claim", {});
    if (!isRecord(body) || !("job" in body)) {
      throw new Error("Job claim 응답 형식이 올바르지 않습니다.");
    }
    if (body.job === null) return null;
    return parseOnpremAgentJob(body.job);
  }

  async getEcrCredential(jobId: string): Promise<EcrCredential> {
    return validateCredential(
      await this.requestJson(
        `/api/v1/agents/jobs/${encodeURIComponent(jobId)}/ecr-credential`,
        {},
      ),
    );
  }

  async prepareTunnel(
    input: TunnelStartInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<TunnelSession> {
    return validateTunnelSession(
      await this.requestJson(
        `/api/v1/agents/jobs/${encodeURIComponent(input.jobId)}/tunnel`,
        {
          body: {
            deploymentId: input.deploymentId,
            environmentId: input.environmentId,
            localPort: input.localPort,
          },
          signal: options.signal,
        },
      ),
    );
  }

  async prepare(
    input: TunnelStartInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<TunnelSession> {
    return this.prepareTunnel(input, options);
  }

  async reportResult(
    jobId: string,
    result: OnpremExecutionResult,
  ): Promise<void> {
    await this.request(
      `/api/v1/agents/jobs/${encodeURIComponent(jobId)}/result`,
      { body: result },
    );
  }

  async reportCleanupResult(
    jobId: string,
    result: OnpremCleanupResult,
  ): Promise<void> {
    await this.request(
      `/api/v1/agents/cleanup-jobs/${encodeURIComponent(jobId)}/result`,
      { body: result },
    );
  }

  async sendHeartbeat(
    currentJobId?: string,
    runtimes: AgentRuntimeReport[] = [],
  ): Promise<AgentJobHeartbeatResult> {
    const body = await this.requestJson("/api/v1/agents/heartbeat", {
      body: {
        ...(currentJobId ? { currentJobId } : {}),
        ...(runtimes.length > 0 ? { runtimes } : {}),
      },
    });
    if (
      !isRecord(body) ||
      body.ok !== true ||
      (body.deploymentCancelled !== undefined &&
        typeof body.deploymentCancelled !== "boolean") ||
      (body.desiredDeploymentIds !== undefined &&
        (!Array.isArray(body.desiredDeploymentIds) ||
          !body.desiredDeploymentIds.every(
            (deploymentId) => typeof deploymentId === "string" && /^\d+$/.test(deploymentId),
          )))
    ) {
      throw new Error("Agent Heartbeat 응답 형식이 올바르지 않습니다.");
    }
    return {
      ...(body.deploymentCancelled === undefined
        ? {}
        : { jobCancelled: body.deploymentCancelled as boolean }),
      ...(body.desiredDeploymentIds === undefined
        ? {}
        : { desiredDeploymentIds: body.desiredDeploymentIds as string[] }),
    };
  }

  private async requestJson(
    path: string,
    options: { body?: unknown; signal?: AbortSignal },
  ): Promise<unknown> {
    return readJson(await this.request(path, options));
  }

  private async request(
    path: string,
    options: { body?: unknown; signal?: AbortSignal },
  ): Promise<Response> {
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(this.requestTimeoutMs);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout;
      response = await this.fetchRequest(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.credential.agentKey}`,
          ...(options.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        signal,
      });
    } catch {
      throw new Error("Control Plane 요청에 실패했습니다.");
    }
    if (!response.ok) {
      throw new Error(`Control Plane 요청에 실패했습니다. (HTTP ${response.status})`);
    }
    return response;
  }
}
