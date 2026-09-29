/**
 * apps/api/src/plugins/pg-listener.ts
 *
 * Postgres LISTEN 통합 — worker의 pg_notify를 API 프로세스가 받아
 * SSE 브로드캐스트로 릴레이한다.
 *
 * 채널: "deployment_events" (worker notifier.ts 와 일치)
 * 페이로드: { deployment_id, event, payload, ts }
 */

import type { PoolClient, Notification } from "pg";
import type { Pool } from "pg";

export type PgListenerOptions = {
  /** LISTEN 채널명. 기본값 "deployment_events" */
  channel?: string;
  /** 알림 수신 콜백 */
  onNotification: (payload: unknown) => void;
};

/**
 * startPgListener — pool에서 전용 클라이언트를 하나 획득해
 * LISTEN <channel>을 등록하고, 알림을 onNotification으로 전달한다.
 *
 * 반환값: unsubscribe 함수 (UNLISTEN + 클라이언트 release).
 */
export async function startPgListener(
  pool: Pool,
  opts: PgListenerOptions
): Promise<() => Promise<void>> {
  const channel = opts.channel ?? "deployment_events";

  const client: PoolClient = await pool.connect();

  client.on("notification", (msg: Notification) => {
    if (msg.channel !== channel) return;
    if (!msg.payload) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.payload);
    } catch {
      // 파싱 실패 — 원문을 그대로 전달
      parsed = msg.payload;
    }
    opts.onNotification(parsed);
  });

  await client.query(`LISTEN ${quoteIdentifier(channel)}`);

  return async () => {
    try {
      await client.query(`UNLISTEN ${quoteIdentifier(channel)}`);
    } catch {
      // 이미 연결이 닫혔을 수 있다 — 무시
    }
    client.removeAllListeners("notification");
    client.release();
  };
}

/** 채널명에 인젝션이 없도록 identifier를 안전하게 인용한다. */
function quoteIdentifier(name: string): string {
  // 영숫자·밑줄만 허용, 아니면 예외
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`pg-listener: invalid channel name: ${name}`);
  }
  return `"${name}"`;
}
