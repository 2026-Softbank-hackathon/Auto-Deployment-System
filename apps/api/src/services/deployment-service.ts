/**
 * apps/api/src/services/deployment-service.ts
 * deployments + source_versions DB 트랜잭션 + pg-boss analyze job 큐.
 */

import { createHash } from "node:crypto";
import type { Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type { Storage } from "@camellia/storage";
import type {
  ApprovalGate,
  AwsConfig,
  CreateDeploymentResponse,
  Deployment,
  DeploymentStatus,
  TargetVendor,
} from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";

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
      ? `https://service-${row.project_id}.apps.${platformDomain}`
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
  targetVendor: TargetVendor;
  targetProfile: string;
  fileBuffer: Buffer;
}

export class DeploymentService {
  constructor(
    private readonly pool: Pool,
    private readonly boss: PgBoss,
    private readonly storage: Storage,
    private readonly platformDomain?: string,
  ) {}

  async create(input: CreateDeploymentInput): Promise<CreateDeploymentResponse> {
    const { projectId, targetVendor, targetProfile, fileBuffer } = input;

    const { targetEnvironmentId, registryEnvironmentId } =
      await this.resolveEnvironments(projectId, targetVendor);

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

  private async resolveEnvironments(
    projectId: number,
    targetVendor: TargetVendor,
  ): Promise<{
    targetEnvironmentId: number;
    registryEnvironmentId: number;
  }> {
    const findDefault = async (type: "aws" | "onprem") => {
      const result = await this.pool.query<{ id: number }>(
        `SELECT id FROM environments
         WHERE project_id = $1 AND type = $2 AND is_default = TRUE
         LIMIT 1`,
        [projectId, type],
      );
      return result.rows[0]?.id ?? null;
    };

    const targetEnvironmentId = await findDefault(targetVendor);
    if (targetEnvironmentId === null) {
      throw new ApiError(
        409,
        "TARGET_ENVIRONMENT_REQUIRED",
        `${targetVendor} 기본 배포 환경이 등록되어 있지 않습니다.`,
        `POST /environments 로 ${targetVendor} 환경을 먼저 등록하세요.`,
      );
    }

    if (targetVendor === "aws") {
      await this.validateRegistryCredentials(projectId, targetEnvironmentId);
      return {
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

    await this.validateRegistryCredentials(projectId, registryEnvironmentId);

    return { targetEnvironmentId, registryEnvironmentId };
  }

  private async validateRegistryCredentials(
    projectId: number,
    environmentId: number,
  ): Promise<void> {
    const result = await this.pool.query<{ aws_config: AwsConfig | null }>(
      `SELECT aws_config
       FROM environments
       WHERE id = $1 AND project_id = $2 AND type = 'aws'`,
      [environmentId, projectId],
    );
    const config = result.rows[0]?.aws_config;

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
       WHERE project_id = $1 AND name = ANY($2::text[])`,
      [projectId, secretNames],
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
