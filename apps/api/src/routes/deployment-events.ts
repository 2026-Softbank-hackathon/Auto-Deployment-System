/**
 * apps/api/src/routes/deployment-events.ts
 * GET /deployments/:id/events — SSE 스트림 (D-31: 메모리 EventEmitter)
 * heartbeat: 30초마다 `: heartbeat\n\n` 전송.
 * Last-Event-Id 헤더로 재연결 시 버퍼에서 replay.
 */

import { type FastifyPluginAsync } from "fastify";
import { ApiError } from "../plugins/error-handler.js";
import { type SseBroker, formatSseMessage } from "../plugins/sse-broker.js";
import type { Pool } from "@camellia/db";
import { idParams } from "../plugins/swagger.js";

const HEARTBEAT_INTERVAL_MS = 30_000;

const deploymentEventsRoutes: FastifyPluginAsync<{
  sseBroker: SseBroker;
  pool: Pool;
}> = async (fastify, opts) => {
  const { sseBroker, pool } = opts;

  fastify.get<{ Params: { id: string } }>("/:id/events", {
    schema: {
      tags: ["deployments"],
      summary: "배포 이벤트 SSE 스트림",
      description: "text/event-stream. 30초마다 heartbeat, Last-Event-Id 헤더로 재연결 시 누락 이벤트 replay.",
      params: idParams,
    },
  }, async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      throw new ApiError(400, "VALIDATION_ERROR", "배포 ID는 양수 정수여야 합니다.");
    }

    // 배포 존재 확인
    const depRes = await pool.query<{ id: number; status: string }>(
      `SELECT id, status FROM deployments WHERE id = $1`,
      [id]
    );
    if (!depRes.rows[0]) {
      throw new ApiError(404, "NOT_FOUND", `배포 ID ${id}를 찾을 수 없습니다.`);
    }

    const deploymentId = String(id);
    const lastEventId = request.headers["last-event-id"] ?? null;
    const lastEventIdStr = Array.isArray(lastEventId) ? (lastEventId[0] ?? null) : lastEventId;

    // SSE 헤더 설정
    void reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    // replay 누락 이벤트
    const replayed = sseBroker.replay(deploymentId, lastEventIdStr);
    for (const evt of replayed) {
      reply.raw.write(formatSseMessage(evt));
    }

    // heartbeat 타이머
    const heartbeatTimer = setInterval(() => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(": heartbeat\n\n");
      }
    }, HEARTBEAT_INTERVAL_MS);

    // 새 이벤트 구독
    const unsubscribe = sseBroker.subscribe(deploymentId, (evt) => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(formatSseMessage(evt));
      }
    });

    // 클라이언트 연결 종료 시 정리
    request.raw.on("close", () => {
      clearInterval(heartbeatTimer);
      unsubscribe();
    });

    // Keep request alive — do not resolve the handler promise
    await new Promise<void>((resolve) => {
      request.raw.on("close", resolve);
    });
  });
};

export default deploymentEventsRoutes;
