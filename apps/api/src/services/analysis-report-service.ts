/**
 * apps/api/src/services/analysis-report-service.ts
 * API-19 분석 리포트 조회 (analysis_reports 테이블 조회).
 */

import type { Pool } from "@camellia/db";
import { ApiError } from "../plugins/error-handler.js";

export type AnalysisReportResponse = {
  deploymentId: number;
  detectedStack: string[];
  services: unknown[];
  resources: unknown[];
  warnings: unknown[];
  unresolved: unknown[];
  irValid: boolean;
  irErrors: unknown[] | null;
  migrationTool: string | null;
  createdAt: string;
};

export class AnalysisReportService {
  constructor(private readonly pool: Pool) {}

  async get(deploymentId: number): Promise<AnalysisReportResponse> {
    const res = await this.pool.query<{
      services_json: unknown[];
      resources_json: unknown[];
      warnings_json: unknown[];
      unresolved_json: unknown[];
      ir_valid: boolean;
      ir_errors_json: unknown[] | null;
      created_at: Date;
    }>(
      `SELECT services_json, resources_json, warnings_json, unresolved_json,
              ir_valid, ir_errors_json, created_at
       FROM analysis_reports
       WHERE deployment_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [deploymentId],
    );
    const row = res.rows[0];
    if (!row) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        `배포 ID ${deploymentId}의 분석 리포트를 찾을 수 없습니다.`,
      );
    }
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
    };
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
