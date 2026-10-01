/**
 * apps/api/src/services/approval-service.ts
 * approvals CRUD + env_lock 획득 (target 승인 시).
 * D-30: env_lock = target 승인 직후 획득.
 */

import type { Pool } from "@camellia/db";
import type { DeploymentStatus, SubmitApprovalResponse } from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";

export interface SubmitApprovalInput {
  deploymentId: number;
  gate: "target" | "plan";
  decision: "approve" | "reject";
  note?: string;
}

// Status transitions
const APPROVAL_REQUIRED_STATUS: Record<string, DeploymentStatus> = {
  target: "awaiting_target_confirmation",
  plan: "awaiting_plan_approval",
};

const APPROVE_NEXT_STATUS: Record<string, DeploymentStatus> = {
  target: "queued",
  plan: "provisioning",
};

export class ApprovalService {
  constructor(private readonly pool: Pool) {}

  async submit(input: SubmitApprovalInput): Promise<SubmitApprovalResponse> {
    const { deploymentId, gate, decision, note } = input;

    const client = await this.pool.connect();
    let committed = false;
    try {
      await client.query("BEGIN");

      // 1. 배포 조회
      const depRes = await client.query<{
        id: number;
        status: string;
        target_environment_id: number | null;
      }>(
        `SELECT id, status, target_environment_id
         FROM deployments WHERE id = $1 FOR UPDATE`,
        [deploymentId]
      );
      const dep = depRes.rows[0];
      if (!dep) {
        throw new ApiError(404, "NOT_FOUND", `배포 ID ${deploymentId}를 찾을 수 없습니다.`);
      }

      const required = APPROVAL_REQUIRED_STATUS[gate]!;
      if (dep.status !== required) {
        throw new ApiError(
          409,
          "APPROVAL_GATE_NOT_PENDING",
          `현재 승인 대기 게이트가 없습니다. 현재 상태: ${dep.status}`,
          "GET /deployments/:id 로 상태를 확인하세요."
        );
      }

      // 2. approvals row 기록
      await client.query(
        `INSERT INTO approvals (deployment_id, gate, decision, note, decided_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (deployment_id, gate)
         DO UPDATE SET decision = $3, note = $4, decided_at = NOW()`,
        [deploymentId, gate, decision, note ?? null]
      );

      // 3. 상태 전이
      let newStatus: DeploymentStatus;
      let lockAcquired = false;

      if (decision === "approve") {
        newStatus = APPROVE_NEXT_STATUS[gate]!;

        // target 승인 시: env_lock 획득 (D-30)
        if (gate === "target") {
          if (dep.target_environment_id === null) {
            throw new ApiError(
              409,
              "TARGET_ENVIRONMENT_REQUIRED",
              "배포 대상 Environment가 연결되어 있지 않습니다.",
            );
          }
          const envKey = `environment:${dep.target_environment_id}`;
          const leaseExpires = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2시간

          // 충돌 시 409 DEPLOYMENT_LOCKED
          try {
            await client.query(
              `INSERT INTO env_locks (env_key, deployment_id, lease_expires_at)
               VALUES ($1, $2, $3)`,
              [envKey, deploymentId, leaseExpires]
            );
            lockAcquired = true;
          } catch (err: unknown) {
            if (
              err instanceof Error &&
              (err as NodeJS.ErrnoException & { code?: string }).code === "23505"
            ) {
              throw new ApiError(
                409,
                "DEPLOYMENT_LOCKED",
                `${envKey} 환경에 이미 진행 중인 배포가 있습니다.`,
                "GET /deployments/:id 로 현재 배포를 확인하거나 완료 후 다시 시도하세요."
              );
            }
            throw err;
          }
        }
      } else {
        newStatus = "failed";
      }

      await client.query(
        `UPDATE deployments
         SET status = $1, updated_at = NOW()
         WHERE id = $2`,
        [newStatus, deploymentId]
      );

      await client.query("COMMIT");
      committed = true;

      return {
        deploymentId: String(deploymentId),
        gate,
        decision,
        newStatus,
        lockAcquired: gate === "target" ? lockAcquired : undefined,
      };
    } catch (err) {
      if (!committed) await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async failBuildQueue(deploymentId: number): Promise<void> {
    await this.pool.query(
      `UPDATE deployments
       SET status = 'failed', error = 'BUILD_QUEUE_FAILED',
           failed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'queued'`,
      [deploymentId],
    );
    await this.pool.query(`DELETE FROM env_locks WHERE deployment_id = $1`, [
      deploymentId,
    ]);
  }
}
