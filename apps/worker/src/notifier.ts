/**
 * apps/worker/src/notifier.ts
 *
 * Postgres NOTIFY 유틸 — deployment_events 채널로 이벤트를 발행한다.
 * API 프로세스가 LISTEN해서 SSE로 브로드캐스트 (D-11 계승, D-31).
 *
 * 채널: "deployment_events"
 * 페이로드: { deployment_id, event, payload, ts }
 */

import type { Pool } from "@camellia/db";

export type Notifier = {
  notify(deploymentId: number, event: string, payload: unknown): Promise<void>;
};

export function createPgNotifier(pool: Pool): Notifier {
  return {
    async notify(deploymentId, event, payload) {
      const msg = JSON.stringify({
        deployment_id: deploymentId,
        event,
        payload,
        ts: new Date().toISOString(),
      });
      await pool.query("SELECT pg_notify($1, $2)", ["deployment_events", msg]);
    },
  };
}
