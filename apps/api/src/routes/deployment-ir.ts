/**
 * apps/api/src/routes/deployment-ir.ts
 * GET  /deployments/:id/ir  — 최신 IR 조회
 * PATCH /deployments/:id/ir — IR 수동 편집 + SSE 브로드캐스트
 */

import { type FastifyPluginAsync } from "fastify";
import { PatchIrBodySchema, type DeploymentEventData } from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";
import { IrService } from "../services/ir-service.js";
import { type SseBroker } from "../plugins/sse-broker.js";
import { idParams, toJsonSchema } from "../plugins/swagger.js";

const deploymentIrRoutes: FastifyPluginAsync<{
  irService: IrService;
  sseBroker: SseBroker;
}> = async (fastify, opts) => {
  const { irService, sseBroker } = opts;

  // GET /deployments/:id/ir
  fastify.get<{ Params: { id: string } }>("/:id/ir", {
    schema: { tags: ["deployments"], summary: "최신 IR 조회", params: idParams },
  }, async (request) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "배포 ID는 양수 정수여야 합니다.");
    }
    return irService.getLatest(id);
  });

  // PATCH /deployments/:id/ir
  fastify.patch<{ Params: { id: string } }>("/:id/ir", {
    schema: {
      tags: ["deployments"],
      summary: "IR 수동 편집",
      params: idParams,
      body: toJsonSchema(PatchIrBodySchema),
    },
  }, async (request, reply) => {
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
      } satisfies DeploymentEventData<"ir_updated">,
    });

    return reply.status(200).send(result);
  });
};

export default deploymentIrRoutes;
