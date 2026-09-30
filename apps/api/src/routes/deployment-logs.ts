/**
 * apps/api/src/routes/deployment-logs.ts
 * GET /deployments/:id/logs?step=analyze|build|provision|verify&tail=N (API-12)
 * P0: stream=false만 지원 (text/plain). stream=true는 P1.
 * 로그 없음 → 204.
 */

import { type FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ApiError } from "../plugins/error-handler.js";
import type { LogService } from "../services/log-service.js";

const LogsQuerySchema = z.object({
  step: z.enum(["analyze", "build", "provision", "verify"]),
  tail: z.coerce.number().int().positive().optional(),
  stream: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .default(false)
    .transform((v) => v === true || v === "true"),
});

const deploymentLogsRoutes: FastifyPluginAsync<{
  logService: LogService;
}> = async (fastify, opts) => {
  const svc = opts.logService;

  fastify.get<{ Params: { id: string }; Querystring: unknown }>(
    "/:id/logs",
    async (request, reply) => {
      const id = Number(request.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "배포 ID는 양수 정수여야 합니다.",
        );
      }

      const query = LogsQuerySchema.parse(request.query);

      if (query.stream) {
        throw new ApiError(
          400,
          "NOT_IMPLEMENTED",
          "stream=true는 P1에서 지원됩니다. 지금은 stream=false로 요청하세요.",
        );
      }

      const result = await svc.get(id, query.step, query.tail);
      if (!result.hasContent) {
        return reply.status(204).send();
      }
      return reply.type("text/plain").status(200).send(result.text);
    },
  );
};

export default deploymentLogsRoutes;
