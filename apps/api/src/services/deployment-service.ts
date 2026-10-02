/**
 * apps/api/src/services/deployment-service.ts
 * deployments + source_versions DB 트랜잭션 + pg-boss analyze job 큐.
 */

import { createHash } from "node:crypto";
import { enqueueOnpremCleanup, type Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import type {
  ApprovalGate,
  AwsConfig,
  CancelDeploymentResponse,
  CreateDeploymentResponse,
  DeployMode,
  Deployment,
  DeploymentStatus,
  RedeployResponse,
  TargetVendor,
} from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";
import { resolveProfile } from "./profile-resolver.js";

export interface DeploymentRow {
  id: number;
  project_id: number;
  status: DeploymentStatus;
  target_profile: string | null;
  target_environment_id: number | string | null;
  registry_environment_id: number | string | null;
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
  gate: ApprovalGate;
  decision: string | null;
  created_at: Date;
}

export function deploymentToDto(
  row: DeploymentRow,
  step?: StepRow | null,
  approval?: ApprovalRow | null,
  /** 플랫폼 도메인. 있으면 고정 서비스 URL 계산, 없으면 null.
   * DB public_url 컬럼은 origin endpoint 저장용으로 재해석 — 응답 publicUrl 은 여기서 계산. */
  platformDomain?: string,
): Deployment {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    status: row.status,
    targetProfile: row.target_profile,
    targetEnvironmentId:
      row.target_environment_id == null ? null : String(row.target_environment_id),
    registryEnvironmentId:
      row.registry_environment_id == null
        ? null
        : String(row.registry_environment_id),
    publicUrl: platformDomain
      ? `https://service-${row.project_id}.${platformDomain}`
      : null,
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
  /** environmentId 가 없으면 필수. 둘 다 있으면 연결 type 과 같아야 한다 */
  targetVendor?: TargetVendor;
  /** 배포할 연결을 직접 고름 (공용 연결 또는 이 프로젝트 연결, #215) */
  environmentId?: number;
  /** 배포 형태 (#282). 주면 앱의 형태도 바꾸고, 없으면 앱에 저장된 형태를 따른다 */
  mode?: DeployMode;
  fileBuffer: Buffer;
}

/** 배포 형태로 서로 바뀌는 AWS 프로필 — 같은 state key 를 쓴다 */
const AWS_COMPUTE_PROFILES = new Set(["aws-ecs-basic", "aws-lambda-basic", "aws-static-basic"]);

export class DeploymentService {
  constructor(
    private readonly pool: Pool,
    private readonly boss: PgBoss,
    private readonly storage: Storage,
    private readonly platformDomain?: string,
  ) {}

  async create(input: CreateDeploymentInput): Promise<CreateDeploymentResponse> {
    const { projectId, fileBuffer } = input;
    await this.assertProjectNotDeleting(projectId);

    const { targetVendor, targetEnvironmentId, registryEnvironmentId } =
      await this.resolveEnvironments(projectId, input.targetVendor, input.environmentId);
    // vendor · 배포 형태 → profile ID 매핑 (연결을 직접 고르면 연결 type 이 vendor)
    const mode = input.mode ?? (await this.projectDeployMode(projectId));
    const targetProfile = resolveProfile(targetVendor, undefined, { mode });

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

      if (input.mode !== undefined) {
        await client.query(`UPDATE projects SET deploy_mode = $1 WHERE id = $2`, [input.mode, projectId]);
      }

      const depRes = await client.query<{ id: number }>(
        `INSERT INTO deployments
           (project_id, status, target_profile, target_environment_id, registry_environment_id)
         VALUES ($1, 'received', $2, $3, $4)
         RETURNING id`,
        [projectId, targetProfile, targetEnvironmentId, registryEnvironmentId]
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

  async get(id: number): Promise<Deployment> {
    const depRes = await this.pool.query<DeploymentRow>(
      `SELECT id, project_id, status, target_profile,
              target_environment_id, registry_environment_id, public_url,
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

    return deploymentToDto(row, step, approval, this.platformDomain);
  }

  /**
   * POST /deployments/:id/cancel
   * - deployments.status → cancelled (state-machine 전 상태에서 유효 전이)
   * - onprem_agent_jobs 중 pending/claimed/running → cancelled (Agent 다음 polling 때 skip)
   * - env_locks DELETE (같은 환경 재배포 unblock)
   * - pg_notify 로 SSE state_changed 자동 발행 (pg-listener plugin 이 relay)
   */
  async cancel(id: number, reason?: string): Promise<CancelDeploymentResponse> {
    const TERMINAL = new Set(["succeeded", "failed", "cancelled", "rejected"]);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const depRes = await client.query<{ status: string }>(
        "SELECT status FROM deployments WHERE id = $1 FOR UPDATE",
        [id],
      );
      const dep = depRes.rows[0];
      if (!dep) {
        throw new ApiError(
          404,
          "NOT_FOUND",
          `배포 ID ${id}를 찾을 수 없습니다.`,
        );
      }
      if (TERMINAL.has(dep.status)) {
        throw new ApiError(
          409,
          "CONFLICT",
          `이미 종료된 배포입니다 (status: ${dep.status})`,
          "진행 중인 배포만 취소할 수 있습니다.",
        );
      }

      const now = new Date();
      await client.query(
        `UPDATE deployments
         SET status = 'cancelled',
             updated_at = NOW(),
             failed_at = COALESCE(failed_at, $1),
             error = COALESCE($2, error)
         WHERE id = $3`,
        [now, reason ?? "user_cancelled", id],
      );

      // 온프레미스 Agent job 신호 — pending/claimed/running 전부 cancelled.
      // Agent 가 다음 claim polling 때 skip 하고, 이미 claim 한 경우 다음 상태 보고 때 플랫폼이 거절.
      await client.query(
        `UPDATE onprem_agent_jobs
         SET status = 'cancelled', updated_at = NOW()
         WHERE deployment_id = $1
           AND status IN ('pending', 'claimed', 'running', 'ready_for_verify')`,
        [id],
      );

      // 이미 실행을 시작한 Agent가 있을 수 있으므로 취소 상태 변경과 같은 트랜잭션에서
      // 멱등 cleanup Job도 예약한다. On-Prem 배포가 아니면 INSERT ... SELECT가 no-op이다.
      await enqueueOnpremCleanup(client, {
        deploymentId: id,
        reason: "deployment_cancelled",
      });

      await client.query(
        "DELETE FROM env_locks WHERE deployment_id = $1",
        [id],
      );

      // pg_notify — pg-listener plugin 이 SSE 로 relay.
      await client.query(
        `SELECT pg_notify('deployment_events', $1::text)`,
        [
          JSON.stringify({
            deployment_id: String(id),
            event: "state_changed",
            payload: { status: "cancelled" },
          }),
        ],
      );

      await client.query("COMMIT");

      return {
        deploymentId: String(id),
        status: "cancelled" as const,
        cancelledAt: now.toISOString(),
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
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

  /**
   * POST /deployments/:id/redeploy
   * - 소스 deployment 의 source_version, ir, target_profile, target_environment_id 재사용
   * - analyze/target 승인 skip → 바로 build job 큐잉
   * - 소스가 진행 중이면 409, IR 없으면 400, env_lock 충돌 시 409
   */
  async redeploy(
    fromDeploymentId: number,
    options?: { targetEnvironmentId?: number; mode?: DeployMode },
  ): Promise<RedeployResponse> {
    // 1. 소스 deployment 조회
    const srcRes = await this.pool.query<{
      id: number;
      status: string;
      target_profile: string | null;
      target_environment_id: number | string | null;
      registry_environment_id: number | string | null;
      project_id: number | string;
    }>(
      `SELECT id, status, target_profile, target_environment_id, registry_environment_id, project_id
       FROM deployments WHERE id = $1`,
      [fromDeploymentId],
    );
    const src = srcRes.rows[0];
    if (!src) {
      throw new ApiError(404, "NOT_FOUND", `배포 ID ${fromDeploymentId}를 찾을 수 없습니다.`);
    }
    await this.assertProjectNotDeleting(src.project_id);

    // 2. 소스가 아직 진행 중이면 409
    const IN_PROGRESS_STATUSES = new Set([
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
      "rollback",
    ]);
    if (IN_PROGRESS_STATUSES.has(src.status)) {
      throw new ApiError(
        409,
        "CONFLICT",
        "소스 배포가 아직 진행 중입니다. 완료 후 재배포할 수 있습니다.",
      );
    }

    // 3. IR 최신 버전 조회 (없으면 400)
    const irRes = await this.pool.query<{
      id: number;
      ir_json: Record<string, unknown>;
      source: string;
    }>(
      `SELECT id, ir_json, source
       FROM ir_versions
       WHERE deployment_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [fromDeploymentId],
    );
    const ir = irRes.rows[0];
    if (!ir) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "소스 배포에 IR이 없습니다. 분석이 완료되지 않은 배포는 재배포할 수 없습니다.",
      );
    }

    // 4. source_version 조회
    const svRes = await this.pool.query<{
      id: number;
      sha256: string;
      storage_key: string;
      size_bytes: number;
    }>(
      `SELECT id, sha256, storage_key, size_bytes
       FROM source_versions
       WHERE deployment_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [fromDeploymentId],
    );
    const sv = svRes.rows[0];

    // 대상 환경을 바꾸면 그 환경 종류에 맞는 프로필과 Registry 환경을 다시 고른다.
    // 같은 환경이면 원본 배포의 값을 그대로 쓴다 (롤백 = 이전 배포를 같은 환경에 재배포).
    // 배포 형태는 앱에 저장된 값(또는 이번에 고른 값)을 따른다 (#282) — 같은 AWS 환경이어도
    // 원본과 형태가 다르면 컨테이너 ↔ 서버리스 프로필을 바꾼다.
    const mode = options?.mode ?? (await this.projectDeployMode(src.project_id));
    let targetEnvironmentId = src.target_environment_id;
    let targetProfile = src.target_profile;
    let registryEnvironmentId = src.registry_environment_id;
    if (targetProfile !== null && AWS_COMPUTE_PROFILES.has(targetProfile)) {
      targetProfile = resolveProfile("aws", ir.ir_json, { mode });
    }
    const overrideId = options?.targetEnvironmentId;
    if (overrideId != null && String(overrideId) !== String(src.target_environment_id)) {
      const target = await this.findRedeployTarget(overrideId, src.project_id);
      targetEnvironmentId = target.id;
      // 원본 IR 로 고른다 — 예: 정적 사이트를 온프레미스 → AWS 로 옮기면 aws-static-basic (#273)
      targetProfile = resolveProfile(target.type, ir.ir_json, { mode });
      registryEnvironmentId =
        target.type === "aws"
          ? target.id
          : await this.findOnpremRegistry(src.project_id, src.registry_environment_id);
      if (String(registryEnvironmentId) !== String(src.registry_environment_id)) {
        await this.validateRegistryCredentials(Number(registryEnvironmentId));
      }
    }

    // 5. env_lock 확인 (같은 프로젝트에서 대상 환경에 진행 중인 배포가 있으면 409)
    if (targetEnvironmentId != null) {
      const lockRes = await this.pool.query<{ id: number }>(
        `SELECT d.id
         FROM deployments d
         WHERE d.target_environment_id = $1
           AND d.status = ANY($2::text[])
           AND d.id != $3
           AND d.project_id = $4
         LIMIT 1`,
        [
          targetEnvironmentId,
          [
            "queued",
            "building",
            "planning",
            "awaiting_plan_approval",
            "provisioning",
            "deploying",
            "verifying",
          ],
          fromDeploymentId,
          src.project_id,
        ],
      );
      if (lockRes.rows.length > 0) {
        throw new ApiError(
          409,
          "DEPLOYMENT_LOCKED",
          "대상 환경이 다른 배포로 잠겨 있습니다. 잠시 후 다시 시도하세요.",
        );
      }
    }

    const redeployIr = targetProfile === src.target_profile
      ? ir.ir_json
      : {
          ...ir.ir_json,
          deploy: {
            ...(ir.ir_json["deploy"] as Record<string, unknown> | undefined),
            profile: targetProfile,
          },
        };

    // 6. DB 트랜잭션: 새 deployment + source_version (재사용) + ir_version (cache 복사)
    const client = await this.pool.connect();
    let newDeploymentId: number;
    try {
      await client.query("BEGIN");

      if (options?.mode !== undefined) {
        await client.query(`UPDATE projects SET deploy_mode = $1 WHERE id = $2`, [options.mode, src.project_id]);
      }

      const depRes = await client.query<{ id: number }>(
        `INSERT INTO deployments
           (project_id, status, target_profile, target_environment_id, registry_environment_id)
         SELECT project_id, 'queued', $2, $3, $4
         FROM deployments WHERE id = $1
         RETURNING id`,
        [fromDeploymentId, targetProfile, targetEnvironmentId, registryEnvironmentId],
      );
      newDeploymentId = depRes.rows[0]!.id;

      // source_version 재사용 (동일 deployment_id 로 새 row 가 아닌, 같은 sha256 참조)
      if (sv) {
        await client.query(
          `INSERT INTO source_versions (deployment_id, sha256, storage_key, size_bytes)
           VALUES ($1, $2, $3, $4)`,
          [newDeploymentId, sv.sha256, sv.storage_key, sv.size_bytes],
        );
      }

      // IR 복사 (source = "analyzer_cache" 로 표시)
      await client.query(
        `INSERT INTO ir_versions (deployment_id, ir_json, source)
         VALUES ($1, $2, 'analyzer_cache')`,
        [newDeploymentId, JSON.stringify(redeployIr)],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // 7. build job 큐잉 (analyze skip)
    await this.boss.send("build", {
      deployment_id: newDeploymentId,
      redeployed_from: fromDeploymentId,
    });

    return {
      deploymentId: String(newDeploymentId),
      status: "queued" as const,
      eventsUrl: `/api/v1/deployments/${newDeploymentId}/events`,
    };
  }

  /** 앱에 저장된 배포 형태 (#282). 프로젝트를 못 찾으면 기본 컨테이너 */
  private async projectDeployMode(projectId: number | string): Promise<DeployMode> {
    const result = await this.pool.query<{ deploy_mode: DeployMode | null }>(
      `SELECT deploy_mode FROM projects WHERE id = $1`,
      [projectId],
    );
    return result.rows[0]?.deploy_mode === "serverless" ? "serverless" : "container";
  }

  /** 삭제 중이거나 삭제에 실패한 앱에는 새 배포를 만들지 않는다 (#247) */
  private async assertProjectNotDeleting(projectId: number | string): Promise<void> {
    const result = await this.pool.query<{ deletion_status: string | null }>(
      `SELECT deletion_status FROM projects WHERE id = $1`,
      [projectId],
    );
    if (result.rows[0]?.deletion_status) {
      throw new ApiError(
        409,
        "PROJECT_DELETING",
        "삭제 중인 앱에는 배포할 수 없습니다.",
        "삭제가 끝난 뒤 새 앱으로 배포하세요.",
      );
    }
  }

  /** 재배포 대상 환경 — 원본 배포의 프로젝트 환경이거나 공용 환경(project_id NULL)이어야 한다. */
  private async findRedeployTarget(
    environmentId: number,
    projectId: number | string,
  ): Promise<{ id: string; type: TargetVendor }> {
    const result = await this.pool.query<{
      id: number | string;
      type: TargetVendor;
      project_id: number | string | null;
    }>(
      `SELECT id, type, project_id FROM environments WHERE id = $1`,
      [environmentId],
    );
    const env = result.rows[0];
    if (!env) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        `환경 ID ${environmentId}를 찾을 수 없습니다.`,
        "GET /environments 로 배포할 수 있는 환경을 확인하세요.",
      );
    }
    if (env.project_id != null && String(env.project_id) !== String(projectId)) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        "다른 프로젝트의 환경으로는 재배포할 수 없습니다.",
        "이 프로젝트의 환경이나 공용 환경을 고르세요.",
      );
    }
    return { id: String(env.id), type: env.type };
  }

  /**
   * 온프레미스 대상의 이미지 Registry(AWS) 환경.
   * 원본 배포의 Registry 가 AWS 면 그대로 (같은 이미지 재사용 가능), 아니면 프로젝트 기본 AWS, 그다음 공용 기본 AWS.
   */
  private async findOnpremRegistry(
    projectId: number | string,
    sourceRegistryId: number | string | null,
  ): Promise<string> {
    const result = await this.pool.query<{ id: number | string }>(
      `SELECT id
       FROM environments WHERE type = 'aws'
         AND (project_id = $1 OR project_id IS NULL)
         AND (id = $2::bigint OR is_default = TRUE)
       ORDER BY COALESCE(id = $2::bigint, FALSE) DESC,
                (project_id IS NULL) ASC,
                id ASC
       LIMIT 1`,
      [projectId, sourceRegistryId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new ApiError(
        409,
        "AWS_REGISTRY_ENVIRONMENT_REQUIRED",
        "On-Prem 배포 이미지를 저장할 기본 AWS 환경이 등록되어 있지 않습니다.",
        "사용자 AWS 계정의 Private ECR을 사용하므로 AWS 환경을 먼저 등록하세요.",
      );
    }
    return String(row.id);
  }

  /**
   * 배포 대상 · 이미지 레지스트리 연결을 정한다 (#215).
   * - environmentId 가 있으면 그 연결 (공용이거나 이 프로젝트 것만). 연결 type 이 vendor
   * - 없으면 vendor 의 프로젝트 기본 연결 → 없으면 공용 기본 연결
   * - On-Prem 이면 레지스트리는 프로젝트 기본 AWS → 공용 기본 AWS
   */
  private async resolveEnvironments(
    projectId: number,
    requestedVendor: TargetVendor | undefined,
    environmentId: number | undefined,
  ): Promise<{
    targetVendor: TargetVendor;
    targetEnvironmentId: number;
    registryEnvironmentId: number;
  }> {
    const findDefault = async (type: "aws" | "onprem") => {
      // 프로젝트 기본 연결을 먼저, 없으면 공용 기본 연결 (NULLS LAST)
      const result = await this.pool.query<{ id: number }>(
        `SELECT id FROM environments
         WHERE (project_id = $1 OR project_id IS NULL)
           AND type = $2 AND is_default = TRUE
         ORDER BY project_id NULLS LAST
         LIMIT 1`,
        [projectId, type],
      );
      return result.rows[0]?.id ?? null;
    };

    let targetVendor: TargetVendor;
    let targetEnvironmentId: number | null;
    if (environmentId !== undefined) {
      const chosen = await this.pool.query<{ id: number; type: TargetVendor }>(
        `SELECT id, type FROM environments
         WHERE id = $1 AND (project_id = $2 OR project_id IS NULL)`,
        [environmentId, projectId],
      );
      const row = chosen.rows[0];
      if (!row) {
        throw new ApiError(
          404,
          "NOT_FOUND",
          `연결 ID ${environmentId}를 찾을 수 없습니다.`,
          "공용 연결이나 이 프로젝트에 등록한 연결만 고를 수 있습니다.",
        );
      }
      if (requestedVendor !== undefined && requestedVendor !== row.type) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          `target(${requestedVendor})이 고른 연결의 종류(${row.type})와 다릅니다.`,
          "environment_id 를 보낼 때는 target 을 생략하거나 연결 종류와 맞추세요.",
        );
      }
      targetVendor = row.type;
      targetEnvironmentId = row.id;
    } else {
      if (requestedVendor === undefined) {
        throw new ApiError(400, "VALIDATION_ERROR", "target 또는 environment_id 가 필요합니다.");
      }
      targetVendor = requestedVendor;
      targetEnvironmentId = await findDefault(targetVendor);
    }

    if (targetEnvironmentId === null) {
      throw new ApiError(
        409,
        "TARGET_ENVIRONMENT_REQUIRED",
        `${targetVendor} 기본 배포 환경이 등록되어 있지 않습니다.`,
        `POST /environments 로 ${targetVendor} 환경을 먼저 등록하세요.`,
      );
    }

    if (targetVendor === "aws") {
      await this.validateRegistryCredentials(targetEnvironmentId);
      return {
        targetVendor,
        targetEnvironmentId,
        registryEnvironmentId: targetEnvironmentId,
      };
    }

    const registryEnvironmentId = await findDefault("aws");
    if (registryEnvironmentId === null) {
      throw new ApiError(
        409,
        "AWS_REGISTRY_ENVIRONMENT_REQUIRED",
        "On-Prem 배포 이미지를 저장할 기본 AWS 환경이 등록되어 있지 않습니다.",
        "사용자 AWS 계정의 Private ECR을 사용하므로 AWS 환경을 먼저 등록하세요.",
      );
    }

    await this.validateRegistryCredentials(registryEnvironmentId);

    return { targetVendor, targetEnvironmentId, registryEnvironmentId };
  }

  /** 시크릿은 연결의 소유 범위(프로젝트 또는 공용)에서 찾는다 (#215) */
  private async validateRegistryCredentials(environmentId: number): Promise<void> {
    const result = await this.pool.query<{
      aws_config: AwsConfig | null;
      project_id: number | string | null;
    }>(
      `SELECT aws_config, project_id
       FROM environments
       WHERE id = $1 AND type = 'aws'`,
      [environmentId],
    );
    const config = result.rows[0]?.aws_config;
    const ownerProjectId = result.rows[0]?.project_id ?? null;

    if (!config || config.credentialsType !== "access_key") return;

    const secretNames = [
      config.accessKeyIdSecretName,
      config.secretAccessKeySecretName,
    ].filter((name): name is string => typeof name === "string" && name.length > 0);

    if (secretNames.length !== 2) {
      throw new ApiError(
        409,
        "AWS_CREDENTIALS_INVALID",
        "AWS 환경에 자격증명 시크릿 참조가 올바르게 설정되어 있지 않습니다.",
        "AWS Environment의 자격증명 설정을 확인하세요.",
      );
    }

    const secretResult = await this.pool.query<{ name: string }>(
      `SELECT name
       FROM secrets
       WHERE project_id IS NOT DISTINCT FROM $1::bigint AND name = ANY($2::text[])`,
      [ownerProjectId, secretNames],
    );
    const found = new Set(secretResult.rows.map((row) => row.name));
    const missing = secretNames.filter((name) => !found.has(name));

    if (missing.length > 0) {
      throw new ApiError(
        409,
        "AWS_CREDENTIALS_MISSING",
        "AWS 환경이 참조하는 자격증명 시크릿이 없습니다.",
        `누락된 시크릿을 다시 등록하세요: ${missing.join(", ")}.`,
      );
    }
  }
}
