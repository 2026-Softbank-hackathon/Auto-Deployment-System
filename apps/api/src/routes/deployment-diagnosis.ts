/**
 * apps/api/src/routes/deployment-diagnosis.ts
 * GET /deployments/:id/diagnosis (API-36)
 */

import { type FastifyPluginAsync } from "fastify";
import { ApiError } from "../plugins/error-handler.js";
import type { DiagnosisService } from "../services/diagnosis-service.js";

const deploymentDiagnosisRoutes: FastifyPluginAsync<{
  diagnosisService: DiagnosisService;
}> = async (fastify, opts) => {
  const svc = opts.diagnosisService;

  fastify.get<{ Params: { id: string } }>(
    "/:id/diagnosis",
    async (request) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "배포 ID는 양수 정수여야 합니다.",
        );
      }
      return svc.get(id);
    },
  );
};

export default deploymentDiagnosisRoutes;
