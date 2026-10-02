/**
 * apps/api/src/routes/agents.ts
 * Agent 등록·인증·Heartbeat 라우트 (민서 요구사항 #1·#6).
 *
 *   POST /environments/:id/agent-registration-token  → 1회용 등록 토큰 발급 (세션 인증)
 *   POST /agents/register                            → 등록 토큰 소비 → 장기 인증키 발급
 *   POST /agents/heartbeat                           → Bearer 토큰 인증 + last_seen_at 갱신
 */

import { type FastifyPluginAsync } from "fastify";
import {
  RegisterAgentBodySchema,
  AgentHeartbeatBodySchema,
} from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";
import type { AgentService } from "../services/agent-service.js";
import type { AgentJobService } from "../services/agent-job-service.js";
import { idParams, toJsonSchema } from "../plugins/swagger.js";

const agentsRoutes: FastifyPluginAsync<{
  agentService: AgentService;
  agentJobService: Pick<AgentJobService, "heartbeat">;
}> = async (
  fastify,
  opts,
) => {
  const svc = opts.agentService;
  const jobService = opts.agentJobService;

  // ── POST /environments/:id/agent-registration-token ─────────────────────────
  // 세션(사용자) 인증. 기존 authPlugin onRequest 훅이 처리.
  fastify.post<{ Params: { id: string } }>(
    "/environments/:id/agent-registration-token",
    {
      schema: {
        tags: ["agents"],
        summary: "On-Prem Agent 1회용 등록 토큰 발급",
        params: idParams,
        response: {
          201: {
            type: "object",
            properties: {
              token: { type: "string" },
              expiresAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new ApiError(400, "VALIDATION_ERROR", "환경 ID 는 양수 정수여야 합니다.");
      }
      const result = await svc.issueRegistrationToken(id);
      return reply.status(201).send(result);
    },
  );

  // ── POST /agents/register ────────────────────────────────────────────────────
  // Agent 가 등록 토큰을 소비하고 장기 인증키를 받는다. 인증 불필요(토큰이 크레덴셜).
  fastify.post(
    "/agents/register",
    {
      schema: {
        tags: ["agents"],
        summary: "Agent 등록 토큰 소비 → 장기 인증키 발급",
        body: toJsonSchema(RegisterAgentBodySchema),
        response: {
          201: {
            type: "object",
            properties: {
              agentId: { type: "string" },
              longLivedKey: { type: "string" },
              environmentId: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = RegisterAgentBodySchema.parse(request.body);
      const result = await svc.register(body.registrationToken);
      return reply.status(201).send(result);
    },
  );

  // ── POST /agents/heartbeat ───────────────────────────────────────────────────
  // Authorization: Bearer <long-lived-key> 검증.
  fastify.post(
    "/agents/heartbeat",
    {
      schema: {
        tags: ["agents"],
        summary: "Agent Heartbeat — last_seen_at 갱신 + 취소 신호 감지",
        body: toJsonSchema(AgentHeartbeatBodySchema),
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              deploymentCancelled: { type: "boolean" },
              desiredDeploymentIds: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      // Agent Bearer 토큰 직접 추출·검증
      const authHeader = request.headers["authorization"];
      const rawHeader = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      const token = rawHeader?.replace(/^Bearer\s+/i, "");

      if (!token) {
        throw new ApiError(
          401,
          "UNAUTHORIZED",
          "Authorization: Bearer <long-lived-key> 헤더가 필요합니다.",
        );
      }

      const agent = await svc.authenticate(token);
      if (!agent) {
        throw new ApiError(401, "UNAUTHORIZED", "유효하지 않은 Agent 인증키입니다.");
      }

      const body = AgentHeartbeatBodySchema.parse(request.body);
      const desiredDeploymentIds = await svc.recordHeartbeat(
        agent.agentId,
        agent.environmentId,
        body.runtimes,
      );
      if (!body.currentJobId) {
        return reply.status(200).send({ ok: true, desiredDeploymentIds });
      }
      const heartbeat = await jobService.heartbeat(
        agent.agentId,
        agent.environmentId,
        body.currentJobId,
      );
      if (!heartbeat.leaseRenewed && !heartbeat.jobCancelled) {
        throw new ApiError(
          409,
          "AGENT_JOB_LEASE_LOST",
          "Agent Job lease를 갱신할 수 없습니다.",
        );
      }

      return reply.status(200).send({
        ok: true,
        desiredDeploymentIds,
        ...(heartbeat.jobCancelled ? { deploymentCancelled: true } : {}),
      });
    },
  );
};

export default agentsRoutes;
