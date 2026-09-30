import { type FastifyPluginAsync } from "fastify";
import { ApiError } from "../plugins/error-handler.js";
import type { DeploymentHealthService } from "../services/deployment-health-service.js";

const deploymentHealthRoutes: FastifyPluginAsync<{
  deploymentHealthService: DeploymentHealthService;
}> = async (fastify, opts) => {
  fastify.get<{ Params: { id: string } }>("/:id/health", async (request) => {
    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "배포 ID는 양수 정수여야 합니다.",
      );
    }
    return opts.deploymentHealthService.get(id);
  });
};

export default deploymentHealthRoutes;
