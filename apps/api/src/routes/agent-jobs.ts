import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError } from "../plugins/error-handler.js";
import type {
  AgentJobService,
  ClaimedOnpremJob,
} from "../services/agent-job-service.js";
import type {
  AgentCleanupJobService,
  ClaimedCleanupJob,
} from "../services/agent-cleanup-job-service.js";

export type AgentIdentity = {
  agentId: number;
  environmentId: number;
};

export type AgentJobsRouteOptions = {
  agentJobService: Pick<
    AgentJobService,
    "claimNext" | "prepareTunnel" | "reportResult"
  >;
  agentCleanupJobService: Pick<
    AgentCleanupJobService,
    "claimNext" | "reportResult"
  >;
  authenticate: (token: string) => Promise<AgentIdentity | null>;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
};

const DEFAULT_POLL_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_LEASE_SECONDS = 90;

const TunnelInputSchema = z.object({
  deploymentId: z.number().int().positive(),
  environmentId: z.string().min(1).max(100),
  localPort: z.number().int().min(1).max(65_535),
}).strict();

const ResultBaseSchema = z.object({
  deploymentId: z.number().int().positive(),
  environmentId: z.string().min(1).max(100),
  jobId: z.string().min(1).max(200),
  imageUri: z.string().min(1),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
});

const ExecutionResultSchema = z.discriminatedUnion("status", [
  ResultBaseSchema.extend({
    status: z.literal("ready_for_verify"),
    runningDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    localUrl: z.string().url(),
    endpoint: z.string().url().refine((value) => value.startsWith("https://")),
  }).strict(),
  ResultBaseSchema.extend({
    status: z.literal("failed"),
    runningDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    localUrl: z.string().url().optional(),
    errorCode: z.enum([
      "invalid_job",
      "ecr_auth_failed",
      "image_pull_failed",
      "digest_mismatch",
      "compose_failed",
      "health_check_failed",
      "tunnel_not_configured",
      "tunnel_failed",
      "cancelled",
      "internal_error",
    ]),
    errorMessage: z.string().min(1).max(500),
  }).strict(),
]);

const CleanupReasonSchema = z.enum([
  "superseded",
  "deployment_failed",
  "deployment_cancelled",
  "project_deleted",
]);

const CleanupResultBaseSchema = z.object({
  jobId: z.string().regex(/^cleanup-[1-9]\d*$/),
  attempt: z.number().int().positive(),
  deploymentId: z.number().int().positive(),
  environmentId: z.string().min(1).max(100),
  reason: CleanupReasonSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
});

const CleanupExecutionResultSchema = z.discriminatedUnion("status", [
  CleanupResultBaseSchema.extend({ status: z.literal("succeeded") }).strict(),
  CleanupResultBaseSchema.extend({
    status: z.literal("failed"),
    errorCode: z.enum(["cleanup_failed", "internal_error"]),
    errorMessage: z.string().min(1).max(500),
  }).strict(),
]);

const agentJobsRoutes: FastifyPluginAsync<AgentJobsRouteOptions> = async (
  fastify,
  options,
) => {
  fastify.post(
    "/cleanup-jobs/claim",
    {
      schema: {
        tags: ["agents"],
        summary: "Agent가 예약된 런타임 cleanup Job을 비차단 claim",
      },
    },
    async (request) => {
      const agent = await authenticateRequest(request.headers["authorization"]);
      const job = await options.agentCleanupJobService.claimNext(
        agent.agentId,
        agent.environmentId,
        MAX_LEASE_SECONDS,
      );
      return { job: job ? normalizeClaimedCleanupJob(job) : null };
    },
  );

  fastify.post<{ Params: { jobId: string } }>(
    "/cleanup-jobs/:jobId/result",
    {
      schema: {
        tags: ["agents"],
        summary: "Agent 런타임 cleanup 결과 저장",
      },
    },
    async (request, reply) => {
      const agent = await authenticateRequest(request.headers["authorization"]);
      const parsed = CleanupExecutionResultSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Agent cleanup 결과가 올바르지 않습니다.");
      }
      await options.agentCleanupJobService.reportResult(
        agent.agentId,
        agent.environmentId,
        request.params.jobId,
        parsed.data,
      );
      return reply.status(204).send();
    },
  );

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

  fastify.post<{ Params: { jobId: string } }>(
    "/jobs/:jobId/tunnel",
    {
      schema: {
        tags: ["agents"],
        summary: "Agent 동적 로컬 포트에 Named Tunnel 준비",
      },
    },
    async (request, reply) => {
      const agent = await authenticateRequest(request.headers["authorization"]);
      const parsed = TunnelInputSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Tunnel 준비 요청이 올바르지 않습니다.");
      }
      const input = parsed.data;
      const session = await options.agentJobService.prepareTunnel(
        agent.agentId,
        agent.environmentId,
        request.params.jobId,
        input,
      );
      return reply
        .header("cache-control", "no-store")
        .header("pragma", "no-cache")
        .send(session);
    },
  );

  fastify.post<{ Params: { jobId: string } }>(
    "/jobs/:jobId/result",
    {
      schema: {
        tags: ["agents"],
        summary: "Agent 실행 결과 저장 및 Verify 연결",
      },
    },
    async (request, reply) => {
      const agent = await authenticateRequest(request.headers["authorization"]);
      const parsed = ExecutionResultSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Agent 실행 결과가 올바르지 않습니다.");
      }
      const result = parsed.data;
      await options.agentJobService.reportResult(
        agent.agentId,
        agent.environmentId,
        request.params.jobId,
        result,
      );
      return reply.status(204).send();
    },
  );

  async function authenticateRequest(
    header: string | string[] | undefined,
  ): Promise<AgentIdentity> {
    const token = parseBearerToken(header);
    const agent = token ? await options.authenticate(token) : null;
    if (!agent) {
      throw new ApiError(401, "UNAUTHORIZED", "유효한 Agent Bearer 인증이 필요합니다.");
    }
    return agent;
  }
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

function normalizeClaimedCleanupJob(job: ClaimedCleanupJob): ClaimedCleanupJob {
  if (
    !/^cleanup-[1-9]\d*$/.test(job.jobId) ||
    !Number.isSafeInteger(job.attempt) ||
    job.attempt < 1 ||
    !Number.isSafeInteger(job.deploymentId) ||
    job.deploymentId < 1 ||
    !job.environmentId
  ) {
    throw new ApiError(500, "AGENT_CLEANUP_JOB_PAYLOAD_INVALID", "저장된 cleanup Job 계약이 올바르지 않습니다.");
  }
  return job;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export default agentJobsRoutes;
