/**
 * apps/api/src/routes/deployment-ai-usage.ts
 * GET /deployments/:id/ai-usage (API-32)
 */

import { type FastifyPluginAsync } from "fastify";
import { ApiError } from "../plugins/error-handler.js";
import type { AiUsageService } from "../services/ai-usage-service.js";

const deploymentAiUsageRoutes: FastifyPluginAsync<{
  aiUsageService: AiUsageService;
}> = async (fastify, opts) => {
  const svc = opts.aiUsageService;

  fastify.get<{ Params: { id: string } }>(
    "/:id/ai-usage",
    async (request) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "배포 ID는 양수 정수여야 합니다.",
        );
      }
      return svc.aggregate(id);
    },
  );
};

export default deploymentAiUsageRoutes;
