/**
 * apps/worker/src/shutdown.ts
 *
 * 종료 신호(SIGTERM · SIGINT)를 받으면 새 작업을 받지 않고, 진행 중인 작업이 끝날 때까지
 * 기다린 뒤 종료한다 (#241). 플랫폼 재배포(compose 가 worker 컨테이너를 교체)마다
 * Terraform apply 가 중간에 끊겨 배포가 provisioning 에 멈추던 문제를 막는다.
 *
 * Terraform · docker buildx 자식 프로세스는 신호를 받지 않는다 — tini(init: true)와 tsx 는
 * node 프로세스에만 신호를 전달한다. 그래서 작업이 끝날 때까지 자식이 그대로 돈다.
 */

import type PgBoss from "pg-boss";
import type { Logger } from "pino";

/**
 * 진행 중 작업을 기다리는 최대 시간. Terraform apply(ECS · ALB 생성)가 끝날 만큼 잡는다.
 * infra/platform/compose.yaml 의 worker stop_grace_period(30m)보다 짧아야 SIGKILL 전에 끝난다.
 */
export const DRAIN_TIMEOUT_MS = 25 * 60 * 1000;

let activeJobs = 0;

/** 진행 중인 작업 수 (워커 하트비트용, #308) */
export function activeJobCount(): number {
  return activeJobs;
}

/** pg-boss work 콜백을 감싸 진행 중인 작업 수를 센다 (드레인 로그 · 하트비트용). */
export function trackActive<T>(
  handler: (jobs: PgBoss.Job<T>[]) => Promise<void>,
): (jobs: PgBoss.Job<T>[]) => Promise<void> {
  return async (jobs) => {
    activeJobs += 1;
    try {
      await handler(jobs);
    } finally {
      activeJobs -= 1;
    }
  };
}

type ShutdownDeps = {
  boss: { stop(options: { graceful: boolean; timeout: number }): Promise<void> };
  pool: { end(): Promise<void> };
  log: Pick<Logger, "info" | "warn" | "error">;
  exit: (code: number) => void;
  /** 워커 하트비트 (#308). 드레인 시작을 남기고, DB 연결을 닫기 전에 멈춘다. 실패해도 종료는 그대로 */
  heartbeat?: { markDraining(): Promise<void>; stop(): Promise<void> };
};

export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let draining = false;
  return async (signal) => {
    if (draining) {
      deps.log.warn({ signal }, "already draining — signal ignored");
      return;
    }
    draining = true;
    deps.log.info(
      { signal, activeJobs, drainTimeoutMs: DRAIN_TIMEOUT_MS },
      `draining ${activeJobs} active job(s) — no new jobs will be taken`,
    );
    await deps.heartbeat?.markDraining().catch((err: unknown) => {
      deps.log.warn({ err }, "worker heartbeat draining update failed");
    });
    try {
      // graceful: 새 작업 fetch 를 멈추고 진행 중인 작업을 timeout 까지 기다린다.
      // timeout 이 지나도 남은 작업은 pg-boss 가 실패 처리해 재시도 큐로 돌려보낸다.
      await deps.boss.stop({ graceful: true, timeout: DRAIN_TIMEOUT_MS });
      if (activeJobs > 0) {
        // 남은 작업이 DB 연결을 잡고 있어 pool.end() 가 끝나지 않으므로 기다리지 않는다
        deps.log.warn(
          { activeJobs },
          "drain timed out — unfinished jobs were handed back to pg-boss for retry",
        );
        deps.exit(1);
        return;
      }
      await deps.heartbeat?.stop().catch((err: unknown) => {
        deps.log.warn({ err }, "worker heartbeat stop failed");
      });
      await deps.pool.end();
      deps.log.info("worker stopped");
      deps.exit(0);
    } catch (err) {
      deps.log.error({ err }, "worker shutdown failed");
      deps.exit(1);
    }
  };
}
