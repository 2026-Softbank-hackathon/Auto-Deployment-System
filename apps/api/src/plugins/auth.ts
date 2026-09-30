/**
 * apps/api/src/plugins/auth.ts
 * X-API-Key 헤더 검증 또는 dev 모드 자동 우회.
 * NODE_ENV=development(또는 미지정) + API_KEY 환경변수 없으면 bypass.
 */

import { type FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { ApiError } from "./error-handler.js";

declare module "fastify" {
  interface FastifyRequest {
    isDevBypass: boolean;
  }
}

const authPlugin: FastifyPluginAsync<{ apiKey?: string; nodeEnv?: string }> = async (
  fastify,
  opts
) => {
  const apiKey = opts.apiKey;
  const isDev = (opts.nodeEnv ?? "development") !== "production";

  fastify.decorateRequest("isDevBypass", false);

  fastify.addHook("onRequest", async (request) => {
    // Skip health check
    if (request.url === "/health" || request.url === "/api/v1/health") {
      return;
    }

    // Skip OpenAPI 문서 (Swagger UI · /docs/json). API 호출은 여전히 키 필요
    if (/^\/docs(\/|\?|$)/.test(request.url)) {
      return;
    }

    const headerKey =
      request.headers["x-api-key"] ?? request.headers["authorization"]?.replace(/^Bearer\s+/i, "");

    // dev bypass: no API_KEY configured AND not production
    if (!apiKey && isDev) {
      request.isDevBypass = true;
      return;
    }

    if (!headerKey) {
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "Authorization 헤더가 없습니다.",
        "API Key를 X-API-Key 또는 Authorization: Bearer <key> 헤더로 전달하세요."
      );
    }

    if (apiKey && headerKey !== apiKey) {
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "유효하지 않은 API Key입니다.",
        "올바른 API Key를 확인하세요."
      );
    }
  });
};

export default fp(authPlugin, { name: "auth" });
