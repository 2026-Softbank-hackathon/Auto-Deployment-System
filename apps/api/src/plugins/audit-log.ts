/**
 * apps/api/src/plugins/audit-log.ts
 * LOG-03 감사 로그 미들웨어.
 *
 * Fastify onResponse hook — POST/PATCH/PUT/DELETE 요청만 자동 기록.
 * GET 은 기록하지 않음 (noise, 보안 가치 낮음).
 *
 * D-50 원칙: metadata 에 시크릿 필드 원문 저장 금지.
 * 실패 시 응답 블로킹 없음 (silent fail + log.warn).
 */

import { type FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import type { AuditLogService } from "../services/audit-log-service.js";

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/** D-50: 시크릿 필드 패턴. 매칭되는 키는 "***" 로 교체 */
const SECRET_KEY_PATTERN = /^(password|value|accessKey.*|secretKey.*|secretAccessKey|token.*)$/i;

/** request body 에서 시크릿 필드를 마스킹한 안전한 복사본 반환 */
export function redactSecrets(obj: unknown, depth = 0): unknown {
  if (depth > 5) return obj; // 순환 참조 · 깊은 중첩 방지
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.map((v) => redactSecrets(v, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      result[key] = "***";
    } else {
      result[key] = redactSecrets(value, depth + 1);
    }
  }
  return result;
}

/**
 * URL path 에서 (resourceType, resourceId) 파싱.
 * 예: /api/v1/deployments/42  → { resourceType: "deployment", resourceId: "42" }
 * 예: /api/v1/projects         → { resourceType: "project", resourceId: null }
 */
export function parseResource(path: string): {
  resourceType: string | null;
  resourceId: string | null;
} {
  // /api/v1/ 접두사 제거
  const stripped = path.replace(/^\/api\/v1\//, "").replace(/\?.*$/, "");
  const segments = stripped.split("/").filter(Boolean);

  if (segments.length === 0) return { resourceType: null, resourceId: null };

  const resourceMap: Record<string, string> = {
    deployments: "deployment",
    projects: "project",
    environments: "environment",
    secrets: "secret",
    agents: "agent",
    auth: "auth",
  };

  const first = segments[0]!;
  const resourceType = resourceMap[first] ?? first.replace(/s$/, ""); // simple singularize
  const resourceId = segments[1] && /^\d+$/.test(segments[1]) ? segments[1] : null;

  return { resourceType, resourceId };
}

/**
 * request context 에서 actor 정보 추출.
 * - Authorization: Bearer <session-token>  → actorType: 'session', actorId: token prefix
 * - dev bypass                              → actorType: 'system', actorId: null
 * - API Key 직접                            → actorType: 'system', actorId: null
 */
function extractActor(
  authHeader: string | string[] | undefined,
  isDevBypass: boolean,
): { actorType: "session" | "agent" | "system"; actorId: string | null } {
  if (isDevBypass) {
    return { actorType: "system", actorId: null };
  }

  const raw = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const token = raw?.replace(/^Bearer\s+/i, "");

  if (!token) {
    return { actorType: "system", actorId: null };
  }

  // session token 은 "sess_" 또는 "ses" prefix 로 식별 (lib/session-token 참고)
  // agent long-lived key 는 base64url 형태
  // 둘 다 식별하기 어려우면 Bearer 존재만으로 session 으로 처리
  // actor_id 는 token 앞 12자 (식별용 prefix, 원문 아님)
  const actorId = token.slice(0, 12) + "…";

  return { actorType: "session", actorId };
}

const auditLogPlugin: FastifyPluginAsync<{ auditLogService: AuditLogService }> = async (
  fastify,
  opts,
) => {
  const svc = opts.auditLogService;

  fastify.addHook("onResponse", async (request, reply) => {
    if (!MUTATING_METHODS.has(request.method)) return;

    try {
      const path = (request.url ?? "").split("?")[0] ?? "";
      const action = `${request.method} ${path}`;
      const { resourceType, resourceId } = parseResource(path);
      const { actorType, actorId } = extractActor(
        request.headers["authorization"],
        request.isDevBypass ?? false,
      );

      // request body 마스킹 (시크릿 필드 제거)
      let metadata: Record<string, unknown> | null = null;
      if (request.body && typeof request.body === "object") {
        const redacted = redactSecrets(request.body);
        metadata = redacted as Record<string, unknown>;
      }

      await svc.record({
        actorType,
        actorId,
        action,
        resourceType,
        resourceId,
        statusCode: reply.statusCode,
        requestId: request.id,
        metadata,
      });
    } catch (err) {
      // D-50: 실패 시 응답 블로킹 없음
      fastify.log.warn({ err }, "audit-log: failed to record entry");
    }
  });
};

export default fp(auditLogPlugin, { name: "audit-log", dependencies: ["auth"] });
