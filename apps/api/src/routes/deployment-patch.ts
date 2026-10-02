/**
 * apps/api/src/routes/deployment-patch.ts
 * GET /deployments/:id/patch — 코드 수정안(diff) 조회 (PAT-02, #277).
 * 승인 · 거절은 POST /deployments/:id/approvals { gate: "patch" }.
 */

import { type FastifyPluginAsync } from "fastify";
import { ApiError } from "../plugins/error-handler.js";
import { idParams } from "../plugins/swagger.js";
import type { SourcePatchService } from "../services/source-patch-service.js";

const deploymentPatchRoutes: FastifyPluginAsync<{
  sourcePatchService: SourcePatchService;
}> = async (fastify, opts) => {
  fastify.get<{ Params: { id: string } }>(
    "/:id/patch",
    { schema: { tags: ["deployments"], summary: "코드 수정안 조회 (SQLite → PostgreSQL)", params: idParams } },
    async (request) => {
      const id = Number(request.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new ApiError(400, "VALIDATION_ERROR", "배포 ID는 양수 정수여야 합니다.");
      }
      return opts.sourcePatchService.get(id);
    },
  );
};

export default deploymentPatchRoutes;
