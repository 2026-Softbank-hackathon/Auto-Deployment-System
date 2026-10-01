import type { FastifyPluginAsync } from "fastify";
import { ApiError } from "../plugins/error-handler.js";
import type { AgentIdentity } from "./agent-jobs.js";
import type { AgentEcrCredentialService } from "../services/agent-ecr-credential-service.js";

export type AgentEcrCredentialRouteOptions = {
  service: Pick<AgentEcrCredentialService, "issue">;
  authenticate: (token: string) => Promise<AgentIdentity | null>;
};

const agentEcrCredentialRoutes: FastifyPluginAsync<AgentEcrCredentialRouteOptions> = async (
  fastify,
  options,
) => {
  fastify.post<{ Params: { jobId: string } }>(
    "/jobs/:jobId/ecr-credential",
    {
      schema: {
        tags: ["agents"],
        summary: "현재 Agent Job attempt의 ECR 단기 인증정보 1회 조회",
        params: {
          type: "object",
          required: ["jobId"],
          properties: { jobId: { type: "string", pattern: "^\\d+$" } },
        },
      },
    },
    async (request) => {
      const token = bearerToken(request.headers["authorization"]);
      const agent = token ? await options.authenticate(token) : null;
      if (!agent) {
        throw new ApiError(401, "UNAUTHORIZED", "유효한 Agent Bearer 인증이 필요합니다.");
      }
      if (!/^\d+$/.test(request.params.jobId)) {
        throw new ApiError(400, "VALIDATION_ERROR", "Job ID 형식이 올바르지 않습니다.");
      }
      return options.service.issue({ agent, jobId: request.params.jobId });
    },
  );
};

function bearerToken(value: string | string[] | undefined): string | null {
  const header = Array.isArray(value) ? value[0] : value;
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  return match?.[1]?.trim() || null;
}

export default agentEcrCredentialRoutes;
