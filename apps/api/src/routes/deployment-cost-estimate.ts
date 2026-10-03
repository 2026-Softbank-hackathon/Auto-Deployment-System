/**
 * apps/api/src/routes/deployment-cost-estimate.ts
 * GET /deployments/:id/cost-estimate (#327)
 */

import { type FastifyPluginAsync } from "fastify";
import { ApiError } from "../plugins/error-handler.js";
import type { CostEstimateService } from "../services/cost-estimate-service.js";
import { idParams } from "../plugins/swagger.js";

const deploymentCostEstimateRoutes: FastifyPluginAsync<{
  costEstimateService: CostEstimateService;
}> = async (fastify, opts) => {
  const svc = opts.costEstimateService;

  fastify.get<{ Params: { id: string } }>(
    "/:id/cost-estimate",
    { schema: { tags: ["deployments"], summary: "월 예상 인프라 비용 (트래픽 제외 추정치)", params: idParams } },
    async (request) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new ApiError(400, "VALIDATION_ERROR", "배포 ID는 양수 정수여야 합니다.");
      }
      return svc.estimate(id);
    },
  );
};

export default deploymentCostEstimateRoutes;
