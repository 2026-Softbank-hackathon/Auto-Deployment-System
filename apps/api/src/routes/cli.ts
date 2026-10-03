/**
 * apps/api/src/routes/cli.ts — CLI 지원 (UI-02)
 *
 *   GET  /api/v1/cli/manifest → CLI 가 명령을 만드는 목록 (apps/api/src/cli/manifest.ts)
 *   POST /api/v1/cli/token    → CLI 로그인 토큰 (30일). 콘솔 로그인(Basic Auth)으로 부른다
 */

import { type FastifyPluginAsync } from "fastify";
import { CLI_MANIFEST } from "../cli/manifest.js";
import { ApiError } from "../plugins/error-handler.js";
import type { SessionService } from "../services/session-service.js";

export const CLI_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

const cliRoutes: FastifyPluginAsync<{ sessionService?: SessionService }> = async (fastify, opts) => {
  fastify.get("/manifest", { schema: { tags: ["cli"], summary: "CLI 명령 목록" } }, async () => CLI_MANIFEST);

  fastify.post("/token", { schema: { tags: ["cli"], summary: "CLI 로그인 토큰 발급 (30일)" } }, async (_request, reply) => {
    if (!opts.sessionService) {
      throw new ApiError(503, "MISCONFIGURED", "토큰을 발급할 수 없습니다.", "API_KEY 환경변수를 설정하세요.");
    }
    return reply.status(201).send(opts.sessionService.issue(CLI_TOKEN_TTL_SEC));
  });
};

export default cliRoutes;
