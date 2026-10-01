/**
 * apps/api/src/services/analysis-report-service.ts
 * API-19 분석 리포트 조회 (analysis_reports 테이블 조회).
 */

import type { Pool } from "@camellia/db";
import type { AnalysisReport } from "@camellia/contracts";
import { PLATFORM_INJECTED_ENV_NAMES } from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";

export type AnalysisReportResponse = AnalysisReport;

const PLATFORM_INJECTED_ENV_SET = new Set<string>(PLATFORM_INJECTED_ENV_NAMES);

export class AnalysisReportService {
  constructor(private readonly pool: Pool) {}

  async get(deploymentId: number): Promise<AnalysisReportResponse> {
    const [reportRes, irRes] = await Promise.all([
      this.pool.query<{
        services_json: unknown[];
        resources_json: unknown[];
        warnings_json: unknown[];
        unresolved_json: unknown[];
        ir_valid: boolean;
        ir_errors_json: unknown[] | null;
        created_at: Date;
        project_id: number;
      }>(
        `SELECT ar.services_json, ar.resources_json, ar.warnings_json, ar.unresolved_json,
                ar.ir_valid, ar.ir_errors_json, ar.created_at,
                d.project_id
         FROM analysis_reports ar
         JOIN deployments d ON d.id = ar.deployment_id
         WHERE ar.deployment_id = $1
         ORDER BY ar.id DESC
         LIMIT 1`,
        [deploymentId],
      ),
      this.pool.query<{ ir_json: unknown }>(
        `SELECT ir_json
         FROM ir_versions
         WHERE deployment_id = $1
         ORDER BY id DESC
         LIMIT 1`,
        [deploymentId],
      ),
    ]);

    const row = reportRes.rows[0];
    if (!row) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        `배포 ID ${deploymentId}의 분석 리포트를 찾을 수 없습니다.`,
      );
    }

    const irRow = irRes.rows[0];
    const missingEnvNames = irRow
      ? await this.computeMissingEnvNames(row.project_id, irRow.ir_json)
      : null;

    return {
      deploymentId,
      detectedStack: extractDetectedStack(row.services_json),
      services: row.services_json,
      resources: row.resources_json,
      warnings: row.warnings_json,
      unresolved: row.unresolved_json,
      irValid: row.ir_valid,
      irErrors: row.ir_errors_json,
      migrationTool: null,
      createdAt: row.created_at.toISOString(),
      missingEnvNames,
    };
  }

  /**
   * IR 에서 선언된 환경변수 중 다음 조건을 모두 만족하는 이름 목록을 반환한다:
   *   1. user env_vars 에 미등록
   *   2. env_defaults 에도 없음
   *   3. 플랫폼 자동 주입 목록에도 없음
   */
  private async computeMissingEnvNames(
    projectId: number,
    irJson: unknown,
  ): Promise<string[]> {
    const { envNames, envDefaults } = extractEnvInfo(irJson);
    if (envNames.length === 0) return [];

    const dbRes = await this.pool.query<{ name: string }>(
      `SELECT name FROM env_vars WHERE project_id = $1 AND name = ANY($2::text[])`,
      [projectId, envNames],
    );
    const registeredNames = new Set(dbRes.rows.map((r) => r.name));

    return envNames.filter(
      (name) =>
        !registeredNames.has(name) &&
        !(name in envDefaults) &&
        !PLATFORM_INJECTED_ENV_SET.has(name),
    );
  }
}

function extractDetectedStack(services: unknown[]): string[] {
  const stack = new Set<string>();
  for (const svc of services) {
    if (svc !== null && typeof svc === "object") {
      const language = (svc as Record<string, unknown>)["language"];
      if (
        typeof language === "string" &&
        language.length > 0 &&
        language !== "unknown"
      ) {
        stack.add(language);
      }
    }
  }
  return [...stack];
}

/**
 * IR JSON 에서 모든 서비스의 env 이름 목록과 env_defaults 맵을 추출한다.
 * IR 형태가 맞지 않으면 빈 값으로 graceful 처리.
 */
function extractEnvInfo(irJson: unknown): {
  envNames: string[];
  envDefaults: Record<string, string>;
} {
  if (irJson === null || typeof irJson !== "object") {
    return { envNames: [], envDefaults: {} };
  }
  const ir = irJson as Record<string, unknown>;
  const services = ir["services"];
  if (services === null || typeof services !== "object") {
    return { envNames: [], envDefaults: {} };
  }

  const allEnvNames = new Set<string>();
  const allEnvDefaults: Record<string, string> = {};

  for (const svc of Object.values(services as Record<string, unknown>)) {
    if (svc === null || typeof svc !== "object") continue;
    const service = svc as Record<string, unknown>;

    const env = service["env"];
    if (Array.isArray(env)) {
      for (const name of env) {
        if (typeof name === "string") allEnvNames.add(name);
      }
    }

    const envDefaults = service["env_defaults"];
    if (envDefaults !== null && typeof envDefaults === "object" && !Array.isArray(envDefaults)) {
      for (const [k, v] of Object.entries(envDefaults as Record<string, unknown>)) {
        if (typeof v === "string") allEnvDefaults[k] = v;
      }
    }
  }

  return { envNames: [...allEnvNames], envDefaults: allEnvDefaults };
}
