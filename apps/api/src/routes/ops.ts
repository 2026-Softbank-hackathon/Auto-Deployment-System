/**
 * apps/api/src/routes/ops.ts
 * 플랫폼 운영 화면 API (#308). 다른 /api/v1 라우트와 같은 인증(authPlugin)을 받는다.
 *
 *   GET /api/v1/ops/queue · /ops/server · /ops/ai-usage · /ops/deploys
 */

import { type FastifyPluginAsync } from "fastify";
import type { OpsService } from "../services/ops-service.js";

const opsRoutes: FastifyPluginAsync<{ opsService: OpsService }> = async (fastify, opts) => {
  const svc = opts.opsService;

  fastify.get("/queue", { schema: { tags: ["ops"], summary: "작업 큐 · 워커 상태" } }, async () => svc.queue());
  fastify.get("/server", { schema: { tags: ["ops"], summary: "플랫폼 서버 지표" } }, async () => svc.server());
  fastify.get("/ai-usage", { schema: { tags: ["ops"], summary: "AI 사용량 · 비용 추정치" } }, async () => svc.aiUsage());
  fastify.get("/deploys", { schema: { tags: ["ops"], summary: "플랫폼 자동 배포(CD) 기록" } }, async () => svc.deploys());
};

export default opsRoutes;
