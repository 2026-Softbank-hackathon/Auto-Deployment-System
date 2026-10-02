/**
 * apps/api/src/services/project-service.ts
 * projects 테이블 CRUD.
 */

import { enqueueOnpremCleanup, type Pool } from "@camellia/db";
import type PgBoss from "pg-boss";
import type {
  DeleteProjectResponse,
  DeployMode,
  DeploymentStatus,
  Project,
  ProjectDeletion,
  ProjectDeletionStatus,
  ProjectDeletionWarning,
  ProjectDeployment,
  ProjectDeploymentList,
  ProjectList,
  SubdomainAvailability,
  TargetVendor,
} from "@camellia/contracts";
import { projectSubdomain, servicePublicUrl, subdomainProblem } from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";

export interface ProjectRow {
  id: number;
  name: string;
  description: string | null;
  created_at: Date;
  updated_at: Date;
  /** 배포 형태 (#282). 읽지 않았으면 기본 container */
  deploy_mode?: DeployMode | null;
  /** 앱 주소 (#300). 비어 있으면 service-{id} */
  subdomain?: string | null;
  /** 삭제 요청 상태 (#247). POST /projects 의 RETURNING 처럼 읽지 않으면 undefined */
  deletion_status?: ProjectDeletionStatus | null;
  deletion_error?: string | null;
  deletion_requested_at?: Date | null;
  deletion_warnings?: ProjectDeletionWarning[] | null;
}

/** 프로젝트 목록 · 조회 row — live(지금 서비스 중인 배포) · latest(최근 배포) 요약을 함께 읽는다 */
export interface ProjectSummaryRow extends ProjectRow {
  live_deployment_id: number | string | null;
  live_environment_id: number | string | null;
  live_environment_type: TargetVendor | null;
  live_environment_name: string | null;
  live_target_profile: string | null;
  live_succeeded_at: Date | null;
  latest_deployment_id: number | string | null;
  latest_status: DeploymentStatus | null;
  latest_environment_type: TargetVendor | null;
  latest_created_at: Date | null;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
  /** 앱 주소 (#300). 계약 스키마로 정리 · 검증한 값. 없으면 DB 가 service-{id} 로 채운다 */
  subdomain?: string;
}

/** 주소 사용 여부 확인과 저장이 겹치지 않도록 거는 트랜잭션 advisory lock 키 */
const SUBDOMAIN_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('projects.subdomain'))`;

function subdomainTakenError(subdomain: string): ApiError {
  return new ApiError(
    409,
    "SUBDOMAIN_TAKEN",
    `주소 "${subdomain}" 는 다른 앱이 쓰고 있습니다.`,
    "다른 주소를 입력하세요.",
  );
}

/** 다른 앱이 이 주소를 쓰는지 (대소문자 무시). excludeProjectId 는 자기 자신 */
async function isSubdomainTaken(
  db: { query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }> },
  subdomain: string,
  excludeProjectId?: number,
): Promise<boolean> {
  const result = await db.query(
    `SELECT id FROM projects WHERE lower(subdomain) = $1 AND ($2::bigint IS NULL OR id <> $2) LIMIT 1`,
    [subdomain.toLowerCase(), excludeProjectId ?? null],
  );
  return result.rows.length > 0;
}

function idOrNull(value: number | string | null): string | null {
  return value === null ? null : String(value);
}

function deletionToDto(row: ProjectRow): ProjectDeletion | null {
  if (!row.deletion_status || !row.deletion_requested_at) return null;
  return {
    status: row.deletion_status,
    requestedAt: row.deletion_requested_at.toISOString(),
    error: row.deletion_error ?? null,
    warnings: row.deletion_warnings ?? [],
  };
}

/** 끝난 배포 상태 — 나머지는 진행 중이라 앱을 지울 수 없다 */
const FINISHED_DEPLOYMENT_STATUSES: DeploymentStatus[] = ["succeeded", "failed", "cancelled", "rejected"];

/** POST /projects 처럼 요약 컬럼이 없는 row 는 live · latest 가 null */
export function projectToDto(row: ProjectRow | ProjectSummaryRow, platformDomain?: string): Project {
  const summary = "live_deployment_id" in row ? row : null;
  const subdomain = projectSubdomain(row.subdomain, row.id);
  const publicUrl = servicePublicUrl(subdomain, platformDomain);
  return {
    id: String(row.id),
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deployMode: row.deploy_mode === "serverless" ? "serverless" : "container",
    subdomain,
    publicUrl,
    live:
      summary?.live_deployment_id != null
        ? {
            deploymentId: String(summary.live_deployment_id),
            environmentId: idOrNull(summary.live_environment_id),
            environmentType: summary.live_environment_type,
            environmentName: summary.live_environment_name,
            targetProfile: summary.live_target_profile ?? null,
            publicUrl,
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
    deletion: deletionToDto(row),
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
  SELECT p.id, p.name, p.description, p.created_at, p.updated_at, p.deploy_mode, p.subdomain,
         p.deletion_status, p.deletion_error, p.deletion_requested_at, p.deletion_warnings,
         live.id AS live_deployment_id,
         live.target_environment_id AS live_environment_id,
         live_env.type AS live_environment_type,
         live_env.name AS live_environment_name,
         live.target_profile AS live_target_profile,
         live.succeeded_at AS live_succeeded_at,
         latest.id AS latest_deployment_id,
         latest.status AS latest_status,
         latest_env.type AS latest_environment_type,
         latest.created_at AS latest_created_at
  FROM projects p
  LEFT JOIN LATERAL (
    SELECT d.id, d.target_environment_id, d.target_profile, d.succeeded_at FROM deployments d
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

export function projectDeploymentToDto(
  row: ProjectDeploymentRow,
  platformDomain?: string,
  subdomain?: string | null,
): ProjectDeployment {
  return {
    id: String(row.id),
    status: row.status,
    targetProfile: row.target_profile,
    publicUrl: servicePublicUrl(projectSubdomain(subdomain, row.project_id), platformDomain),
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
    private readonly boss?: Pick<PgBoss, "send">,
  ) {}

  /**
   * DELETE /projects/:id — 앱 삭제 요청 (#247).
   * 진행 중인 배포가 없으면 deleting 으로 바꾸고 teardown 잡을 넣는다. 실제 정리(Terraform destroy ·
   * 공개 주소 · DB row 삭제)는 워커가 한다. 실패(failed)나 진행 중(deleting)에 다시 요청하면 잡을 다시 넣는다
   * — teardown 큐는 프로젝트마다 대기 · 실행 잡을 하나씩만 두고, 워커는 끝난 프로젝트를 건너뛴다.
   */
  async requestDeletion(id: number): Promise<DeleteProjectResponse> {
    if (!this.boss) throw new ApiError(500, "INTERNAL_ERROR", "작업 큐가 설정되지 않았습니다.");
    const client = await this.pool.connect();
    let deletion: ProjectDeletion;
    try {
      await client.query("BEGIN");
      // 배포 생성(deployments FK)과 겹치지 않도록 프로젝트 row 를 잠근다
      const project = await client.query(`SELECT id FROM projects WHERE id = $1 FOR UPDATE`, [id]);
      if (project.rows.length === 0) {
        throw new ApiError(404, "NOT_FOUND", `프로젝트 ID ${id}를 찾을 수 없습니다.`, "ID를 확인하세요.");
      }
      const active = await client.query(
        `SELECT id, status FROM deployments WHERE project_id = $1 AND NOT (status = ANY($2::text[])) LIMIT 1`,
        [id, FINISHED_DEPLOYMENT_STATUSES],
      );
      if (active.rows.length > 0) {
        throw new ApiError(
          409,
          "PROJECT_DEPLOYMENT_IN_PROGRESS",
          "진행 중인 배포가 있어 앱을 삭제할 수 없습니다.",
          "배포가 끝나거나 취소한 뒤 다시 시도하세요.",
        );
      }
      const onprem = await client.query<{ id: number | string }>(
        `SELECT DISTINCT d.id
         FROM deployments d
         JOIN onprem_agent_jobs job ON job.deployment_id = d.id
         WHERE d.project_id = $1
         ORDER BY d.id`,
        [id],
      );
      for (const deployment of onprem.rows) {
        await enqueueOnpremCleanup(client, {
          deploymentId: Number(deployment.id),
          reason: "project_deleted",
        });
      }
      const warnings: ProjectDeletionWarning[] = [];
      const updated = await client.query<ProjectRow>(
        `UPDATE projects
         SET deletion_status = 'deleting',
             deletion_error = NULL,
             deletion_requested_at = CASE WHEN deletion_status = 'deleting'
                                          THEN deletion_requested_at ELSE NOW() END,
             deletion_warnings = $2::text[]
         WHERE id = $1
         RETURNING deletion_status, deletion_error, deletion_requested_at, deletion_warnings`,
        [id, warnings],
      );
      const row = updated.rows[0];
      const dto = row ? deletionToDto(row) : null;
      if (!dto) throw new ApiError(500, "INTERNAL_ERROR", "삭제 요청을 저장하지 못했습니다.");
      deletion = dto;
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // teardown 큐는 stately — 같은 프로젝트(singletonKey)의 destroy 가 겹쳐 돌지 않는다.
    // destroy(ECS · ALB · VPC 삭제)가 기본 만료(15분)보다 길 수 있어 1시간, 실패는 워커가 failed 로 기록하므로 재시도 없음.
    await this.boss.send("teardown", { project_id: id }, {
      singletonKey: `project-${id}`,
      expireInSeconds: 60 * 60,
      retryLimit: 0,
    });
    return { projectId: String(id), deletion };
  }

  async create(input: CreateProjectInput): Promise<Project> {
    const { name, description, subdomain } = input;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (subdomain !== undefined) {
        await client.query(SUBDOMAIN_LOCK_SQL);
        if (await isSubdomainTaken(client, subdomain)) throw subdomainTakenError(subdomain);
      }
      const res = await client.query<ProjectRow>(
        `INSERT INTO projects (name, description, subdomain)
         VALUES ($1, $2, $3)
         RETURNING id, name, description, created_at, updated_at, deploy_mode, subdomain`,
        [name, description ?? null, subdomain ?? null]
      );
      const row = res.rows[0];
      if (!row) throw new ApiError(500, "INTERNAL_ERROR", "프로젝트 생성에 실패했습니다.");
      await client.query("COMMIT");
      return projectToDto(row, this.platformDomain);
    } catch (err: unknown) {
      await client.query("ROLLBACK");
      // Postgres unique violation: code 23505 — 이름 또는 주소(projects_subdomain_unique)
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException & { code?: string }).code === "23505"
      ) {
        if ((err as { constraint?: string }).constraint === "projects_subdomain_unique" && subdomain) {
          throw subdomainTakenError(subdomain);
        }
        throw new ApiError(409, "CONFLICT", `이름 "${name}"의 프로젝트가 이미 존재합니다.`, "다른 이름을 사용하세요.");
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** GET /projects/subdomain-availability — 형식 · 예약어는 DB 를 보지 않고 답한다 */
  async subdomainAvailability(rawName: string): Promise<SubdomainAvailability> {
    const name = rawName.trim().toLowerCase();
    const problem = subdomainProblem(name);
    if (problem) return { name, available: false, reason: problem };
    if (await isSubdomainTaken(this.pool, name)) return { name, available: false, reason: "taken" };
    return { name, available: true, reason: null };
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

    const exists = await this.pool.query<{ subdomain: string | null }>(
      `SELECT subdomain FROM projects WHERE id = $1`,
      [projectId],
    );
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
    const subdomain = exists.rows[0]?.subdomain ?? null;
    const items = rows.slice(0, limit).map((r) => projectDeploymentToDto(r, this.platformDomain, subdomain));
    const nextCursor = hasMore ? String(rows[limit - 1]!.id) : null;

    return { items, nextCursor };
  }
}
