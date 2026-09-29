/**
 * apps/api/src/routes/deployment-ir.ts
 * GET  /deployments/:id/ir  — 최신 IR 조회
 * PATCH /deployments/:id/ir — IR 수동 편집 + SSE 브로드캐스트
 */

import { type FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError } from "../plugins/error-handler.js";
import { IrService } from "../services/ir-service.js";
import { type SseBroker } from "../plugins/sse-broker.js";

const PatchIrBodySchema = z.object({
  ir: z.record(z.string(), z.unknown()),
  version: z.number().int(),
});

const deploymentIrRoutes: FastifyPluginAsync<{
  irService: IrService;
  sseBroker: SseBroker;
}> = async (fastify, opts) => {
  const { irService, sseBroker } = opts;

  // GET /deployments/:id/ir
  fastify.get<{ Params: { id: string } }>("/:id/ir", async (request) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "배포 ID는 양수 정수여야 합니다.");
    }
    return irService.getLatest(id);
  });

  // PATCH /deployments/:id/ir
  fastify.patch<{ Params: { id: string } }>("/:id/ir", async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "배포 ID는 양수 정수여야 합니다.");
    }

    const body = PatchIrBodySchema.parse(request.body);
    const result = await irService.patch(id, body.ir, body.version);

    // SSE 브로드캐스트
    sseBroker.publish(String(id), {
      event: "ir_updated",
      data: {
        deploymentId: String(id),
        version: result.version,
        source: result.source,
      },
    });

    return reply.status(200).send(result);
  });
};

export default deploymentIrRoutes;
