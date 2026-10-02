/**
 * apps/worker/src/worker-heartbeat.ts
 *
 * 워커 하트비트 (#308). 워커 프로세스마다 worker_heartbeats 한 행을 10초마다 upsert 한다.
 * 운영 화면은 last_seen_at 이 30초 넘게 지나면 오프라인으로 본다.
 * 종료 신호로 드레인을 시작하면(shutdown.ts) draining=true 를 바로 남긴다.
 * DB 오류는 경고만 남긴다 — 하트비트 때문에 작업 처리가 멈추면 안 된다.
 */

import type { Logger } from "pino";

export const HEARTBEAT_INTERVAL_MS = 10_000;

type HeartbeatDeps = {
  pool: { query(sql: string, params?: unknown[]): Promise<unknown> };
  log: Pick<Logger, "warn">;
  workerId: string;
  hostname: string;
  /** 워커 이미지의 커밋 (CAMELLIA_COMMIT). 모르면 null */
  commit: string | null;
  startedAt: Date;
  activeJobs: () => number;
  intervalMs?: number;
};

export type WorkerHeartbeat = {
  start(): Promise<void>;
  markDraining(): Promise<void>;
  stop(): Promise<void>;
};

export function createWorkerHeartbeat(deps: HeartbeatDeps): WorkerHeartbeat {
  let draining = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function beat(): Promise<void> {
    try {
      await deps.pool.query(
        `INSERT INTO worker_heartbeats (worker_id, hostname, commit_sha, started_at, last_seen_at, draining, active_jobs)
         VALUES ($1, $2, $3, $4, now(), $5, $6)
         ON CONFLICT (worker_id) DO UPDATE
           SET last_seen_at = now(), draining = EXCLUDED.draining, active_jobs = EXCLUDED.active_jobs`,
        [deps.workerId, deps.hostname, deps.commit, deps.startedAt, draining, deps.activeJobs()],
      );
    } catch (err) {
      deps.log.warn({ err }, "worker heartbeat failed");
    }
  }

  return {
    async start() {
      await beat();
      timer = setInterval(() => void beat(), deps.intervalMs ?? HEARTBEAT_INTERVAL_MS);
      timer.unref?.();
    },
    async markDraining() {
      draining = true;
      await beat();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await beat();
    },
  };
}
