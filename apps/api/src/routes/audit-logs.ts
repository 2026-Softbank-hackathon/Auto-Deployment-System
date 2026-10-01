/**
 * apps/api/src/routes/audit-logs.ts
 * LOG-03 감사 로그 조회 API.
 *
 *   GET /api/v1/audit-logs?actor=&resource=&action=&limit=50&cursor=
 *
 * 세션 인증 필요 (authPlugin onRequest 훅이 처리).
 * 응답: { items: [...], nextCursor: string|null }
 */

import { type FastifyPluginAsync } from "fastify";
import { AuditLogsQuerySchema } from "@camellia/contracts";
import type { AuditLogService } from "../services/audit-log-service.js";
import { toJsonSchema } from "../plugins/swagger.js";

const auditLogsRoutes: FastifyPluginAsync<{ auditLogService: AuditLogService }> = async (
  fastify,
  opts,
) => {
  const svc = opts.auditLogService;

  fastify.get("/", {
    schema: {
      tags: ["audit-logs"],
      summary: "감사 로그 조회 (커서 페이지네이션)",
      querystring: toJsonSchema(AuditLogsQuerySchema),
    },
  }, async (request) => {
    const q = AuditLogsQuerySchema.parse(request.query);

    // actor 파싱: "session:abc123" → actorType="session", actorId="abc123"
    let actorType: string | undefined;
    let actorId: string | undefined;
    if (q.actor) {
      const colonIdx = q.actor.indexOf(":");
      if (colonIdx >= 0) {
        actorType = q.actor.slice(0, colonIdx);
        actorId = q.actor.slice(colonIdx + 1);
      } else {
        actorType = q.actor;
      }
    }

    // resource 파싱: "deployment:42" → resourceType="deployment", resourceId="42"
    let resourceType: string | undefined;
    let resourceId: string | undefined;
    if (q.resource) {
      const colonIdx = q.resource.indexOf(":");
      if (colonIdx >= 0) {
        resourceType = q.resource.slice(0, colonIdx);
        resourceId = q.resource.slice(colonIdx + 1);
      } else {
        resourceType = q.resource;
      }
    }

    return svc.list({
      actorType,
      actorId,
      resourceType,
      resourceId,
      actionPrefix: q.action,
      limit: q.limit,
      cursor: q.cursor,
    });
  });
};

export default auditLogsRoutes;
