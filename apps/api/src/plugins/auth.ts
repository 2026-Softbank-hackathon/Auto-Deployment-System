/**
 * apps/api/src/plugins/auth.ts
 * X-API-Key / Bearer(API Key 또는 API-01 세션 토큰) 검증. dev 모드 자동 우회.
 * NODE_ENV=development(또는 미지정) + API_KEY 환경변수 없으면 bypass.
 */

import { type FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { sessionSigningKey, verifySessionToken } from "../lib/session-token.js";
import { ApiError } from "./error-handler.js";

declare module "fastify" {
  interface FastifyRequest {
    isDevBypass: boolean;
  }
}

function requestPath(url: string): string {
  return url.split("?")[0] ?? url;
}

/** Node 헤더 값은 string | string[] 일 수 있다 — 단일 문자열로 정규화 */
function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const authPlugin: FastifyPluginAsync<{
  apiKey?: string;
  nodeEnv?: string;
  agentJobClaimEnabled?: boolean;
  agentEcrCredentialEnabled?: boolean;
}> = async (
  fastify,
  opts
) => {
  const apiKey = opts.apiKey;
  const isDev = (opts.nodeEnv ?? "development") !== "production";
  const sessionKey = apiKey ? sessionSigningKey(apiKey) : undefined;

  fastify.decorateRequest("isDevBypass", false);

  fastify.addHook("onRequest", async (request) => {
    const path = requestPath(request.url);

    // Skip health check
    if (path === "/health" || path === "/api/v1/health") {
      return;
    }

    // Skip OpenAPI 문서 (Swagger UI · /docs/json). API 호출은 여전히 키 필요
    if (/^\/docs(\/|\?|$)/.test(request.url)) {
      return;
    }

    // API-01: 세션 발급은 본문 apiKey 로만 인증
    if (request.method === "POST" && path === "/api/v1/auth/session") {
      return;
    }

    // Agent 등록·Heartbeat: 등록 토큰 / 장기 키 자체가 크레덴셜 — 세션 인증 불필요
    if (
      request.method === "POST" &&
      (path === "/api/v1/agents/register" || path === "/api/v1/agents/heartbeat")
    ) {
      return;
    }

    // Agent Job API는 라우트에서 장기 Agent Key와 Job 소유권을 함께 검증한다.
    if (
      opts.agentJobClaimEnabled &&
      request.method === "POST" &&
      (path === "/api/v1/agents/jobs/claim" ||
        path === "/api/v1/agents/cleanup-jobs/claim" ||
        /^\/api\/v1\/agents\/jobs\/[^/]+\/(?:tunnel|result)$/.test(path) ||
        /^\/api\/v1\/agents\/cleanup-jobs\/[^/]+\/result$/.test(path))
    ) {
      return;
    }

    if (
      opts.agentEcrCredentialEnabled &&
      request.method === "POST" &&
      /^\/api\/v1\/agents\/jobs\/[^/]+\/ecr-credential$/.test(path)
    ) {
      return;
    }

    const headerKey =
      headerValue(request.headers["x-api-key"]) ??
      headerValue(request.headers["authorization"])?.replace(/^Bearer\s+/i, "");

    // dev bypass: no API_KEY configured AND not production
    if (!apiKey && isDev) {
      request.isDevBypass = true;
      return;
    }

    if (!apiKey && !isDev) {
      throw new ApiError(
        503,
        "MISCONFIGURED",
        "API_KEY가 설정되지 않았습니다.",
        "NODE_ENV=production 에서 API_KEY 환경변수를 설정하세요."
      );
    }

    if (!headerKey) {
      throw new ApiError(
        401,
        "UNAUTHORIZED",
        "Authorization 헤더가 없습니다.",
        "API Key를 X-API-Key 또는 Authorization: Bearer <key> 헤더로 전달하세요."
      );
    }

    if (apiKey && headerKey === apiKey) {
      return;
    }

    if (sessionKey && verifySessionToken(headerKey, sessionKey)) {
      return;
    }

    throw new ApiError(
      401,
      "UNAUTHORIZED",
      "유효하지 않은 API Key입니다.",
      "올바른 API Key 또는 세션 토큰을 확인하세요."
    );
  });
};

export default fp(authPlugin, { name: "auth" });
