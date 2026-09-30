/**
 * apps/api/src/plugins/request-id.ts
 * 모든 요청에 X-Request-Id 헤더를 할당하고 응답에 포함한다.
 * requestId 형식: req_ + randomUUID(26자 슬라이스)
 */

import { type FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";

const requestIdPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook("onRequest", async (request, reply) => {
    const incoming = request.headers["x-request-id"];
    const id =
      typeof incoming === "string" && incoming.length > 0
        ? incoming
        : `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`;
    // Store on request object for downstream use
    (request as unknown as Record<string, unknown>)["requestId"] = id;
    void reply.header("x-request-id", id);
  });
};

// Re-export default with fp so the plugin is not encapsulated
export default fp(requestIdPlugin, { name: "request-id" });

/**
 * Helper to get requestId from a request.
 */
export function getRequestId(request: { headers: Record<string, unknown> }): string {
  // The id is attached by Fastify's built-in genReqId or our hook
  return (
    ((request as unknown as Record<string, unknown>)["requestId"] as string | undefined) ??
    `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 26)}`
  );
}
