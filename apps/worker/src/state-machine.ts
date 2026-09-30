/**
 * apps/worker/src/state-machine.ts
 *
 * v5.4.1 16-상태 전이표 + transitionTo 유틸.
 * 정상 경로: received → analyzing → awaiting_patch_approval →
 *   awaiting_target_confirmation → queued → building → planning →
 *   awaiting_plan_approval → provisioning → deploying → verifying → succeeded
 * 실패: 어느 상태에서든 failed 허용.
 *
 * API-36 자동 진단: transitionTo(..., "failed", { boss }) 로 부르면
 * COMMIT 성공 후 boss.send("diagnose") 를 자동 큐잉한다.
 */

import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";

// ---------------------------------------------------------------------------
// 상태 상수
// ---------------------------------------------------------------------------

export const STATUSES = [
  "received",
  "analyzing",
  "awaiting_patch_approval",
  "awaiting_target_confirmation",
  "queued",
  "building",
  "planning",
  "awaiting_plan_approval",
  "provisioning",
  "deploying",
  "verifying",
  "succeeded",
  "failed",
  "cancelled",
  "rejected",
  "rollback",
] as const;

export type Status = (typeof STATUSES)[number];

// ---------------------------------------------------------------------------
// 유효 전이표 (정방향만; failed/cancelled 는 별도 허용)
// ---------------------------------------------------------------------------

export const VALID_TRANSITIONS: Record<Status, Status[]> = {
  received: ["analyzing", "failed", "cancelled"],
  analyzing: ["awaiting_patch_approval", "awaiting_target_confirmation", "failed", "cancelled"],
  awaiting_patch_approval: ["awaiting_target_confirmation", "failed", "cancelled", "rejected"],
  awaiting_target_confirmation: ["queued", "failed", "cancelled", "rejected"],
  queued: ["building", "failed", "cancelled"],
  building: ["planning", "failed", "cancelled"],
  planning: ["awaiting_plan_approval", "failed", "cancelled"],
  awaiting_plan_approval: ["provisioning", "failed", "cancelled", "rejected"],
  provisioning: ["deploying", "failed", "cancelled"],
  deploying: ["verifying", "failed", "rollback"],
  verifying: ["succeeded", "failed", "rollback"],
  succeeded: [],
  failed: [],
  cancelled: [],
  rejected: [],
  rollback: ["failed", "succeeded"],
};

// ---------------------------------------------------------------------------
// transitionTo
// ---------------------------------------------------------------------------

/** transitionTo 확장 옵션. reason 은 하위 호환용으로 string 직접 전달도 허용. */
export type TransitionOptions = {
  reason?: string;
  /** 지정 시, next === "failed" 로 COMMIT 성공하면 boss.send("diagnose", ...) 자동 enqueue (API-36). */
  boss?: PgBoss;
};

/**
 * deploymentId의 상태를 next로 전이한다.
 * 현재 상태를 SELECT FOR UPDATE로 잠근 뒤 전이 유효성을 검사하고 UPDATE.
 *
 * 4번째 인자는 하위 호환을 위해 string(=reason) 또는 TransitionOptions 둘 다 허용.
 *
 * @throws Error — 현재 상태를 찾을 수 없거나 유효하지 않은 전이인 경우
 */
export async function transitionTo(
  pool: Pool,
  deploymentId: number,
  next: Status,
  reasonOrOpts?: string | TransitionOptions
): Promise<void> {
  const opts: TransitionOptions =
    typeof reasonOrOpts === "string" ? { reason: reasonOrOpts } : (reasonOrOpts ?? {});

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const res = await client.query<{ status: string }>(
      "SELECT status FROM deployments WHERE id = $1 FOR UPDATE",
      [deploymentId]
    );
    const row = res.rows[0];
    if (!row) {
      throw new Error(`transitionTo: deployment ${deploymentId} not found`);
    }

    const current = row.status as Status;
    const allowed = VALID_TRANSITIONS[current] ?? [];

    if (!allowed.includes(next)) {
      throw new Error(
        `transitionTo: invalid transition ${current} → ${next} for deployment ${deploymentId}`
      );
    }

    const now = new Date();
    const succeededAt = next === "succeeded" ? now : null;
    const failedAt = next === "failed" ? now : null;

    await client.query(
      `UPDATE deployments
       SET status = $1,
           updated_at = NOW(),
           succeeded_at = COALESCE($2, succeeded_at),
           failed_at    = COALESCE($3, failed_at),
           error        = COALESCE($4, error)
       WHERE id = $5`,
      [next, succeededAt, failedAt, opts.reason ?? null, deploymentId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // COMMIT 성공 후: failed 로 전이했고 boss 가 주입되었으면 diagnose 자동 큐잉 (API-36).
  // 큐잉 실패는 배포 상태 전이 성공을 방해하지 않는다.
  if (next === "failed" && opts.boss) {
    try {
      await opts.boss.send("diagnose", { deployment_id: deploymentId });
    } catch {
      // ignore — 진단 큐잉 실패는 fatal 이 아니다
    }
  }
}
