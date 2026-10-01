import type { FastifyPluginAsync } from "fastify";
import { ApiError } from "../plugins/error-handler.js";
import type {
  AgentJobService,
  ClaimedOnpremJob,
} from "../services/agent-job-service.js";

export type AgentIdentity = {
  agentId: number;
  environmentId: number;
};

export type AgentJobsRouteOptions = {
  agentJobService: Pick<AgentJobService, "claimNext">;
  authenticate: (token: string) => Promise<AgentIdentity | null>;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
};

const DEFAULT_POLL_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_LEASE_SECONDS = 90;

const agentJobsRoutes: FastifyPluginAsync<AgentJobsRouteOptions> = async (
  fastify,
  options,
) => {
  fastify.post(
    "/jobs/claim",
    {
      schema: {
        tags: ["agents"],
        summary: "Agent가 자기 Environment의 배포 Job을 long-poll 방식으로 claim",
        response: {
          200: {
            type: "object",
            required: ["job"],
            properties: {
              job: {
                anyOf: [
                  { type: "object", additionalProperties: true },
                  { type: "null" },
                ],
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const token = parseBearerToken(request.headers["authorization"]);
      const agent = token ? await options.authenticate(token) : null;
      if (!agent) {
        throw new ApiError(401, "UNAUTHORIZED", "유효한 Agent Bearer 인증이 필요합니다.");
      }

      const timeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
      const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const deadline = Date.now() + timeoutMs;
      while (!request.raw.aborted && !reply.raw.destroyed) {
        const job = await options.agentJobService.claimNext(
          agent.agentId,
          agent.environmentId,
          MAX_LEASE_SECONDS,
        );
        if (job) return { job: normalizeClaimedJob(job) };
        const remaining = deadline - Date.now();
        if (remaining <= 0) return { job: null };
        await wait(Math.min(intervalMs, remaining));
      }
      return reply;
    },
  );
};

function parseBearerToken(value: string | string[] | undefined): string | null {
  const header = Array.isArray(value) ? value[0] : value;
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  return match?.[1]?.trim() || null;
}

function normalizeClaimedJob(job: ClaimedOnpremJob): ClaimedOnpremJob {
  if (
    !/^\d+$/.test(job.jobId) ||
    !Number.isSafeInteger(job.attempt) ||
    job.attempt < 1 ||
    !Number.isSafeInteger(job.deploymentId) ||
    job.deploymentId < 1 ||
    !job.environmentId
  ) {
    throw new ApiError(500, "AGENT_JOB_PAYLOAD_INVALID", "저장된 Agent Job 계약이 올바르지 않습니다.");
  }
  return job;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export default agentJobsRoutes;
