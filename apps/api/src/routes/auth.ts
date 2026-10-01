/**
 * apps/api/src/routes/auth.ts — API-01 세션 인증 발급
 */

import { type FastifyPluginAsync } from "fastify";
import { CreateSessionBodySchema, SessionResponseSchema } from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";
import { toJsonSchema } from "../plugins/swagger.js";
import {
  clientRateLimitKey,
  SessionRateLimiter,
  SessionService,
} from "../services/session-service.js";

const rateLimiter = new SessionRateLimiter();

const authRoutes: FastifyPluginAsync<{
  sessionService?: SessionService;
}> = async (fastify, opts) => {
  const sessionService = opts.sessionService;

  fastify.post("/session", {
    schema: {
      tags: ["auth"],
      summary: "API Key 교환 → 단기 세션 토큰 (API-01)",
      security: [],
      body: toJsonSchema(CreateSessionBodySchema),
      response: {
        201: toJsonSchema(SessionResponseSchema),
      },
    },
  }, async (request, reply) => {
    if (!sessionService) {
      throw new ApiError(
        503,
        "MISCONFIGURED",
        "세션 발급을 사용할 수 없습니다.",
        "API_KEY 환경변수를 설정하세요.",
      );
    }

    rateLimiter.check(clientRateLimitKey(request.ip));

    const body = CreateSessionBodySchema.parse(request.body);
    const session = sessionService.create(body.apiKey);
    return reply.status(201).send(session);
  });
};

export default authRoutes;
