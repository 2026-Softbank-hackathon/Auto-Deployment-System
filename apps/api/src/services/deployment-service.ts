/**
 * apps/api/src/services/deployment-service.ts
 * deployments + source_versions DB 트랜잭션 + pg-boss analyze job 큐.
 */

import { createHash } from "node:crypto";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import { ApiError } from "../plugins/error-handler.js";

export interface DeploymentRow {
  id: number;
  project_id: number;
  status: string;
  target_profile: string | null;
  public_url: string | null;
  created_at: Date;
  updated_at: Date;
  succeeded_at: Date | null;
  failed_at: Date | null;
  error: string | null;
}

export interface StepRow {
  step_name: string;
  status: string;
  started_at: Date;
  finished_at: Date | null;
}

export interface ApprovalRow {
  gate: string;
  decision: string | null;
  created_at: Date;
}

export function deploymentToDto(row: DeploymentRow, step?: StepRow | null, approval?: ApprovalRow | null) {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    status: row.status,
    targetProfile: row.target_profile,
    publicUrl: row.public_url,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    succeededAt: row.succeeded_at?.toISOString() ?? null,
    failedAt: row.failed_at?.toISOString() ?? null,
    error: row.error,
    currentStep: step
      ? {
          name: step.step_name,
          startedAt: step.started_at.toISOString(),
          finishedAt: step.finished_at?.toISOString() ?? null,
        }
      : { name: null, startedAt: null },
    approvalPending: approval && approval.decision === null
      ? {
          gate: approval.gate,
          createdAt: approval.created_at.toISOString(),
          expiresAt: new Date(approval.created_at.getTime() + 30 * 60 * 1000).toISOString(),
        }
      : null,
  };
}

export interface CreateDeploymentInput {
  projectId: number;
  targetProfile: string;
  fileBuffer: Buffer;
}

export class DeploymentService {
  constructor(
    private readonly pool: Pool,
    private readonly boss: PgBoss,
    private readonly storage: Storage
  ) {}

  async create(input: CreateDeploymentInput) {
    const { projectId, targetProfile, fileBuffer } = input;

    // 1. sha256 계산
    const sha256 = createHash("sha256").update(fileBuffer).digest("hex");
    const storageKey = `sources/${sha256}.zip`;

    // 2. storage에 저장
    await this.storage.put(storageKey, fileBuffer);

    // 3. DB 트랜잭션: deployments + source_versions
    const client = await this.pool.connect();
    let deploymentId: number;
    let sourceVersionId: number;
    try {
      await client.query("BEGIN");

      const depRes = await client.query<{ id: number }>(
        `INSERT INTO deployments (project_id, status, target_profile)
         VALUES ($1, 'received', $2)
         RETURNING id`,
        [projectId, targetProfile]
      );
      deploymentId = depRes.rows[0]!.id;

      const svRes = await client.query<{ id: number }>(
        `INSERT INTO source_versions (deployment_id, sha256, storage_key, size_bytes)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [deploymentId, sha256, storageKey, fileBuffer.length]
      );
      sourceVersionId = svRes.rows[0]!.id;

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // 4. pg-boss analyze job 큐
    await this.boss.send("analyze", {
      deployment_id: deploymentId,
      source_version_id: sourceVersionId,
      source_storage_key: storageKey,
      sha256,
    });

    return {
      deploymentId: String(deploymentId),
      status: "received" as const,
      eventsUrl: `/api/v1/deployments/${deploymentId}/events`,
    };
  }

  async get(id: number) {
    const depRes = await this.pool.query<DeploymentRow>(
      `SELECT id, project_id, status, target_profile, public_url,
              created_at, updated_at, succeeded_at, failed_at, error
       FROM deployments WHERE id = $1`,
      [id]
    );
    const row = depRes.rows[0];
    if (!row) {
      throw new ApiError(404, "NOT_FOUND", `배포 ID ${id}를 찾을 수 없습니다.`, "ID를 확인하세요.");
    }

    // 현재 실행 중인 step
    const stepRes = await this.pool.query<StepRow>(
      `SELECT step_name, status, started_at, finished_at
       FROM deployment_steps
       WHERE deployment_id = $1 AND status = 'running'
       ORDER BY started_at DESC LIMIT 1`,
      [id]
    );
    const step = stepRes.rows[0] ?? null;

    // 미결 승인
    const approvalRes = await this.pool.query<ApprovalRow>(
      `SELECT gate, decision, created_at
       FROM approvals
       WHERE deployment_id = $1 AND decision IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [id]
    );
    const approval = approvalRes.rows[0] ?? null;

    return deploymentToDto(row, step, approval);
  }

  async updateStatus(id: number, status: string, extra?: { error?: string; public_url?: string }) {
    const now = new Date();
    const succeededAt = status === "succeeded" ? now : null;
    const failedAt = status === "failed" ? now : null;

    await this.pool.query(
      `UPDATE deployments
       SET status = $1,
           updated_at = NOW(),
           succeeded_at = COALESCE($2, succeeded_at),
           failed_at = COALESCE($3, failed_at),
           error = COALESCE($4, error),
           public_url = COALESCE($5, public_url)
       WHERE id = $6`,
      [
        status,
        succeededAt,
        failedAt,
        extra?.error ?? null,
        extra?.public_url ?? null,
        id,
      ]
    );
  }
}
