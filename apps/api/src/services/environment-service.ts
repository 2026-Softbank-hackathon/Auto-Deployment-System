/**
 * apps/api/src/services/environment-service.ts
 * API-23~26 (REC-01) — 배포 환경 등록·조회·삭제.
 *
 * AWS 자격증명은 secrets 이름으로만 참조 (원시 Access Key 는 environments 에 저장 X).
 * access_key 방식 등록 시 참조하는 secrets 이름이 실제 존재하는지 검증.
 *
 * 소유 범위(#215): projectId 가 있으면 프로젝트 전용 연결, 없으면(NULL) 공용 연결.
 * 기본 연결 · 이름 중복 · 참조 시크릿 검증은 모두 같은 소유 범위 안에서 한다.
 */

import type { Pool } from "@camellia/db";
import type {
  AwsConfig,
  CreateEnvironmentResponse,
  Environment,
  OnpremConfig,
} from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";

export type { AwsConfig, OnpremConfig };
export type EnvironmentDto = Environment;
/** POST /environments 응답 전용 DTO — onpremConfig 에 agentRegistrationToken 을 1회 포함(#61) */
export type CreateEnvironmentDto = CreateEnvironmentResponse;

/** Agent 가 이 시간 안에 연락했으면 연결됨으로 본다 (Agent 폴링 · lease 90초와 맞춤) */
const AGENT_ONLINE_WITHIN_SECONDS = 90;

const ENV_COLUMNS = `
  environment.id, environment.project_id, environment.name, environment.type,
  environment.is_default, environment.aws_config, environment.onprem_config,
  environment.agent_status, environment.last_seen_at, environment.created_at,
  agent.last_seen_at AS agent_last_seen_at,
  COALESCE(agent.last_seen_at > NOW() - INTERVAL '${AGENT_ONLINE_WITHIN_SECONDS} seconds', FALSE) AS agent_online`;

type EnvRow = {
  id: number;
  project_id: number | null;
  name: string;
  type: "aws" | "onprem";
  is_default: boolean;
  aws_config: AwsConfig | null;
  onprem_config: OnpremConfig | null;
  agent_status: string | null;
  last_seen_at: Date | null;
  created_at: Date;
  agent_last_seen_at?: Date | null;
  agent_online?: boolean | null;
};

const ACTIVE_STATUSES = [
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
];

export class EnvironmentService {
  constructor(private readonly pool: Pool) {}

  async create(input: {
    projectId?: number;
    name: string;
    type: "aws" | "onprem";
    isDefault?: boolean;
    awsConfig?: AwsConfig;
    onpremConfig?: OnpremConfig;
  }): Promise<CreateEnvironmentDto> {
    const projectId = input.projectId ?? null;
    if (projectId !== null) {
      const proj = await this.pool.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
      if (proj.rowCount === 0) {
        throw new ApiError(404, "NOT_FOUND", `프로젝트 ID ${projectId}를 찾을 수 없습니다.`);
      }
    }

    if (input.type === "aws") {
      if (!input.awsConfig) {
        throw new ApiError(400, "VALIDATION_ERROR", "aws 환경은 awsConfig 가 필요합니다.");
      }
      if (input.awsConfig.credentialsType === "access_key") {
        const { accessKeyIdSecretName, secretAccessKeySecretName } = input.awsConfig;
        if (!accessKeyIdSecretName || !secretAccessKeySecretName) {
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "access_key 방식은 accessKeyIdSecretName + secretAccessKeySecretName 이 필요합니다.",
          );
        }
        const secretNames = [accessKeyIdSecretName, secretAccessKeySecretName];
        const check = await this.pool.query<{ name: string }>(
          `SELECT name FROM secrets
           WHERE project_id IS NOT DISTINCT FROM $1::bigint AND name = ANY($2::text[])`,
          [projectId, secretNames],
        );
        const found = new Set(check.rows.map((r) => r.name));
        const missing = secretNames.filter((n) => !found.has(n));
        if (missing.length > 0) {
          const scope = projectId === null ? "공용 시크릿" : `프로젝트 ${projectId} 시크릿`;
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            `참조된 시크릿을 ${scope}에서 찾을 수 없습니다: ${missing.join(", ")}. 먼저 POST /secrets 로 저장하세요.`,
          );
        }
      } else {
        if (!input.awsConfig.roleArn || !input.awsConfig.externalId) {
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "assume_role 방식은 roleArn + externalId 가 필요합니다.",
          );
        }
      }
    } else {
      if (!input.onpremConfig) {
        throw new ApiError(400, "VALIDATION_ERROR", "onprem 환경은 onpremConfig 가 필요합니다.");
      }
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `${projectId ?? "shared"}:${input.type}`,
      ]);
      const currentDefault = await client.query<{ id: number }>(
        `SELECT id FROM environments
         WHERE project_id IS NOT DISTINCT FROM $1::bigint AND type = $2 AND is_default = TRUE
         LIMIT 1`,
        [projectId, input.type],
      );
      const hasDefault = currentDefault.rows.length > 0;
      const isDefault = input.isDefault === true || !hasDefault;

      if (isDefault && hasDefault) {
        await client.query(
          `UPDATE environments
           SET is_default = FALSE
           WHERE project_id IS NOT DISTINCT FROM $1::bigint AND type = $2 AND is_default = TRUE`,
          [projectId, input.type],
        );
      }

      const res = await client.query<{
        id: number;
        is_default: boolean;
        created_at: Date;
      }>(
        `INSERT INTO environments
           (project_id, name, type, is_default, aws_config, onprem_config)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, is_default, created_at`,
        [
          projectId,
          input.name,
          input.type,
          isDefault,
          input.awsConfig ? JSON.stringify(input.awsConfig) : null,
          input.onpremConfig ? JSON.stringify(input.onpremConfig) : null,
        ],
      );
      await client.query("COMMIT");
      return {
        id: res.rows[0]!.id,
        projectId,
        shared: projectId === null,
        name: input.name,
        type: input.type,
        isDefault: res.rows[0]!.is_default,
        awsConfig: input.awsConfig,
        onpremConfig: input.onpremConfig,
        agentStatus: null,
        lastSeenAt: null,
        agentOnline: false,
        agentLastSeenAt: null,
        createdAt: res.rows[0]!.created_at.toISOString(),
      };
    } catch (e) {
      await client.query("ROLLBACK");
      const msg = e instanceof Error ? e.message : String(e);
      if (/unique|duplicate/i.test(msg)) {
        const scope = projectId === null ? "공용 연결" : `프로젝트 ${projectId}`;
        throw new ApiError(
          409,
          "CONFLICT",
          `환경 이름 '${input.name}' 이 ${scope} 에 이미 존재합니다.`,
        );
      }
      throw e;
    } finally {
      client.release();
    }
  }

  /** projectId 가 있으면 그 프로젝트 전용 연결, 없으면 공용 연결 목록(#215) */
  async list(input: { projectId?: number }): Promise<EnvironmentDto[]> {
    const res = await this.pool.query<EnvRow>(
      `SELECT ${ENV_COLUMNS}
       FROM environments AS environment
       LEFT JOIN agents AS agent ON agent.environment_id = environment.id
       WHERE environment.project_id IS NOT DISTINCT FROM $1::bigint
       ORDER BY environment.name`,
      [input.projectId ?? null],
    );
    return res.rows.map((r) => this.toDto(r));
  }

  async get(id: number): Promise<EnvironmentDto> {
    const res = await this.pool.query<EnvRow>(
      `SELECT ${ENV_COLUMNS}
       FROM environments AS environment
       LEFT JOIN agents AS agent ON agent.environment_id = environment.id
       WHERE environment.id = $1`,
      [id],
    );
    const row = res.rows[0];
    if (!row) throw new ApiError(404, "NOT_FOUND", `환경 ID ${id}를 찾을 수 없습니다.`);
    return this.toDto(row);
  }

  async delete(id: number): Promise<void> {
    const active = await this.pool.query(
      `SELECT 1 FROM deployments
       WHERE target_environment_id = $1
         AND status = ANY($2::text[])
       LIMIT 1`,
      [id, ACTIVE_STATUSES],
    );
    if ((active.rowCount ?? 0) > 0) {
      throw new ApiError(409, "CONFLICT", "이 연결로 진행 중인 배포가 있어 환경을 삭제할 수 없습니다.");
    }
    let res;
    try {
      res = await this.pool.query(`DELETE FROM environments WHERE id = $1`, [id]);
    } catch (e) {
      // deployments.target/registry_environment_id 가 ON DELETE RESTRICT 로 참조 중
      if ((e as { code?: string }).code === "23503") {
        throw new ApiError(
          409,
          "CONFLICT",
          "이 연결로 배포한 기록이 있어 삭제할 수 없습니다.",
          "배포 기록이 남아 있는 연결은 지울 수 없습니다. 새 연결을 등록해 기본 연결로 바꿔 쓰세요.",
        );
      }
      throw e;
    }
    if (res.rowCount === 0) {
      throw new ApiError(404, "NOT_FOUND", `환경 ID ${id}를 찾을 수 없습니다.`);
    }
  }

  /** 목록/단건 조회 응답. onpremConfig 에서 agentRegistrationToken 은 제거한다(#61) */
  private toDto(row: EnvRow): EnvironmentDto {
    return {
      id: row.id,
      projectId: row.project_id,
      shared: row.project_id === null,
      name: row.name,
      type: row.type,
      isDefault: row.is_default,
      awsConfig: row.aws_config ?? undefined,
      onpremConfig: row.onprem_config
        ? { hostname: row.onprem_config.hostname }
        : undefined,
      agentStatus: row.agent_status ?? null,
      lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
      agentOnline: row.agent_online === true,
      agentLastSeenAt: row.agent_last_seen_at ? row.agent_last_seen_at.toISOString() : null,
      createdAt: row.created_at.toISOString(),
    };
  }
}
