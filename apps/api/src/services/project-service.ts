/**
 * apps/api/src/services/project-service.ts
 * projects 테이블 CRUD.
 */

import type { Pool } from "@camellia/db";
import type {
  DeploymentStatus,
  Project,
  ProjectDeployment,
  ProjectDeploymentList,
  ProjectList,
  TargetVendor,
} from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";

export interface ProjectRow {
  id: number;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
}

/** 프로젝트 목록 · 조회 row — live(지금 서비스 중인 배포) · latest(최근 배포) 요약을 함께 읽는다 */
export interface ProjectSummaryRow extends ProjectRow {
  live_deployment_id: number | string | null;
  live_environment_id: number | string | null;
  live_environment_type: TargetVendor | null;
  live_environment_name: string | null;
  live_succeeded_at: Date | null;
  latest_deployment_id: number | string | null;
  latest_status: DeploymentStatus | null;
  latest_environment_type: TargetVendor | null;
  latest_created_at: Date | null;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
}

/** 프로젝트 공유 주소. 배포 응답(deployment-service)과 같은 규칙 — DB public_url 은 쓰지 않는다 */
function servicePublicUrl(projectId: number | string, platformDomain?: string): string | null {
  return platformDomain ? `https://service-${projectId}.${platformDomain}` : null;
}

function idOrNull(value: number | string | null): string | null {
  return value === null ? null : String(value);
}

/** POST /projects 처럼 요약 컬럼이 없는 row 는 live · latest 가 null */
export function projectToDto(row: ProjectRow | ProjectSummaryRow, platformDomain?: string): Project {
  const summary = "live_deployment_id" in row ? row : null;
  return {
    id: String(row.id),
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    live:
      summary?.live_deployment_id != null
        ? {
            deploymentId: String(summary.live_deployment_id),
            environmentId: idOrNull(summary.live_environment_id),
            environmentType: summary.live_environment_type,
            environmentName: summary.live_environment_name,
            publicUrl: servicePublicUrl(row.id, platformDomain),
            succeededAt: summary.live_succeeded_at?.toISOString() ?? null,
          }
        : null,
    latest:
      summary?.latest_deployment_id != null && summary.latest_status !== null && summary.latest_created_at !== null
        ? {
            deploymentId: String(summary.latest_deployment_id),
            status: summary.latest_status,
            environmentType: summary.latest_environment_type,
            createdAt: summary.latest_created_at.toISOString(),
          }
        : null,
  };
}

/**
 * 지금 프로젝트 주소로 서비스 중인 배포 = 가장 최근에 성공한 배포.
 * verify 가 성공할 때마다 공유 주소의 origin 을 그 배포로 바꾸므로 마지막 성공이 서비스 중이다.
 * `p` 는 바깥 쿼리의 프로젝트 id 식.
 */
function liveDeploymentIdSql(p: string): string {
  return `SELECT ld.id FROM deployments ld
          WHERE ld.project_id = ${p} AND ld.status = 'succeeded'
          ORDER BY ld.succeeded_at DESC NULLS LAST, ld.id DESC
          LIMIT 1`;
}

/** 프로젝트 + live · latest 요약 — 프로젝트마다 쿼리를 따로 날리지 않도록 LATERAL 로 한 번에 읽는다 */
const PROJECT_SUMMARY_SELECT = `
  SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
         live.id AS live_deployment_id,
         live.target_environment_id AS live_environment_id,
         live_env.type AS live_environment_type,
         live_env.name AS live_environment_name,
         live.succeeded_at AS live_succeeded_at,
         latest.id AS latest_deployment_id,
         latest.status AS latest_status,
         latest_env.type AS latest_environment_type,
         latest.created_at AS latest_created_at
  FROM projects p
  LEFT JOIN LATERAL (
    SELECT d.id, d.target_environment_id, d.succeeded_at FROM deployments d
    WHERE d.id = (${liveDeploymentIdSql("p.id")})
  ) live ON true
  LEFT JOIN environments live_env ON live_env.id = live.target_environment_id
  LEFT JOIN LATERAL (
    SELECT d.id, d.status, d.created_at, d.target_environment_id FROM deployments d
    WHERE d.project_id = p.id
    ORDER BY d.id DESC
    LIMIT 1
  ) latest ON true
  LEFT JOIN environments latest_env ON latest_env.id = latest.target_environment_id`;

export interface ProjectDeploymentRow {
  id: number;
  project_id: number;
  status: DeploymentStatus;
  target_profile: string | null;
  public_url: string | null;
  created_at: Date;
  succeeded_at: Date | null;
  failed_at: Date | null;
  source_version_id: number | null;
  source_sha256: string | null;
  environment_id: number | string | null;
  environment_type: TargetVendor | null;
  environment_name: string | null;
  is_live: boolean;
}

export function projectDeploymentToDto(row: ProjectDeploymentRow, platformDomain?: string): ProjectDeployment {
  return {
    id: String(row.id),
    status: row.status,
    targetProfile: row.target_profile,
    publicUrl: servicePublicUrl(row.project_id, platformDomain),
    sourceVersion:
      row.source_version_id !== null
        ? { id: String(row.source_version_id), sha256: row.source_sha256 }
        : null,
    createdAt: row.created_at.toISOString(),
    succeededAt: row.succeeded_at?.toISOString() ?? null,
    failedAt: row.failed_at?.toISOString() ?? null,
    environmentId: idOrNull(row.environment_id),
    environmentType: row.environment_type,
    environmentName: row.environment_name,
    isLive: row.is_live === true,
  };
}

export class ProjectService {
  constructor(
    private readonly pool: Pool,
    private readonly platformDomain?: string,
  ) {}

  async create(input: CreateProjectInput): Promise<Project> {
    const { name, description } = input;
    try {
      const res = await this.pool.query<ProjectRow>(
        `INSERT INTO projects (name, description)
         VALUES ($1, $2)
         RETURNING id, name, description, created_at, updated_at`,
        [name, description ?? null]
      );
      const row = res.rows[0];
      if (!row) throw new ApiError(500, "INTERNAL_ERROR", "프로젝트 생성에 실패했습니다.");
      return projectToDto(row);
    } catch (err: unknown) {
      // Postgres unique violation: code 23505
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException & { code?: string }).code === "23505"
      ) {
        throw new ApiError(409, "CONFLICT", `이름 "${name}"의 프로젝트가 이미 존재합니다.`, "다른 이름을 사용하세요.");
      }
      throw err;
    }
  }

  async list(opts: { limit: number; cursor?: string }): Promise<ProjectList> {
    const { limit, cursor } = opts;
    const res = await this.pool.query<ProjectSummaryRow>(
      `${PROJECT_SUMMARY_SELECT}
       WHERE ($1::bigint IS NULL OR p.id > $1)
       ORDER BY p.id ASC
       LIMIT $2`,
      [cursor ? Number(cursor) : null, limit + 1]
    );
    const rows = res.rows;

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => projectToDto(r, this.platformDomain));
    const nextCursor = hasMore ? String(rows[limit - 1]!.id) : null;

    return { items, nextCursor, total: items.length };
  }

  async get(id: number): Promise<Project> {
    const res = await this.pool.query<ProjectSummaryRow>(
      `${PROJECT_SUMMARY_SELECT}
       WHERE p.id = $1`,
      [id]
    );
    const row = res.rows[0];
    if (!row) {
      throw new ApiError(404, "NOT_FOUND", `프로젝트 ID ${id}를 찾을 수 없습니다.`, "ID를 확인하세요.");
    }
    return projectToDto(row, this.platformDomain);
  }

  /** 프로젝트 배포 이력 — 최신순, id 커서 페이지네이션 (LOG-01). */
  async listDeployments(
    projectId: number,
    opts: { limit: number; cursor?: number; status?: string },
  ): Promise<ProjectDeploymentList> {
    const { limit, cursor, status } = opts;

    const exists = await this.pool.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
    if (exists.rows.length === 0) {
      throw new ApiError(404, "NOT_FOUND", `프로젝트 ID ${projectId}를 찾을 수 없습니다.`, "ID를 확인하세요.");
    }

    const res = await this.pool.query<ProjectDeploymentRow>(
      `SELECT d.id, d.project_id, d.status, d.target_profile, d.public_url,
              d.created_at, d.succeeded_at, d.failed_at,
              sv.id AS source_version_id, sv.sha256 AS source_sha256,
              d.target_environment_id AS environment_id,
              env.type AS environment_type, env.name AS environment_name,
              COALESCE(d.id = (${liveDeploymentIdSql("$1")}), false) AS is_live
       FROM deployments d
       LEFT JOIN environments env ON env.id = d.target_environment_id
       LEFT JOIN LATERAL (
         SELECT id, sha256 FROM source_versions
         WHERE deployment_id = d.id
         ORDER BY id DESC LIMIT 1
       ) sv ON true
       WHERE d.project_id = $1
         AND ($2::text IS NULL OR d.status = $2)
         AND ($3::bigint IS NULL OR d.id < $3)
       ORDER BY d.id DESC
       LIMIT $4`,
      [projectId, status ?? null, cursor ?? null, limit + 1]
    );

    const rows = res.rows;
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => projectDeploymentToDto(r, this.platformDomain));
    const nextCursor = hasMore ? String(rows[limit - 1]!.id) : null;

    return { items, nextCursor };
  }
}
