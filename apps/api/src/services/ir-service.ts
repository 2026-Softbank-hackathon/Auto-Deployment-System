/**
 * apps/api/src/services/ir-service.ts
 * ir_versions 테이블 CRUD.
 * 편집 가능 상태: awaiting_target_confirmation 에서만 허용 (P0).
 */

import type { Pool } from "@camellia/db";
import { IrSchema } from "@camellia/ir-schema";
import { ApiError } from "../plugins/error-handler.js";

export interface IrVersionRow {
  id: number;
  deployment_id: number;
  ir_json: Record<string, unknown>;
  source: string;
  created_at: Date;
}

const EDITABLE_STATUSES = new Set([
  "awaiting_target_confirmation",
  "analyzing",
]);

export class IrService {
  constructor(private readonly pool: Pool) {}

  async getLatest(deploymentId: number) {
    const res = await this.pool.query<IrVersionRow & { version_num: number }>(
      `SELECT iv.id, iv.deployment_id, iv.ir_json, iv.source, iv.created_at,
              ROW_NUMBER() OVER (PARTITION BY iv.deployment_id ORDER BY iv.id ASC) AS version_num
       FROM ir_versions iv
       WHERE iv.deployment_id = $1
       ORDER BY iv.id DESC
       LIMIT 1`,
      [deploymentId]
    );
    const row = res.rows[0];
    if (!row) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        `배포 ID ${deploymentId}의 IR이 없습니다.`,
        "분석이 완료된 뒤 다시 조회하세요."
      );
    }
    return this.toDto(row, row.version_num);
  }

  async patch(deploymentId: number, irPartial: unknown, requestedVersion: number) {
    // 1. 현재 배포 상태 확인
    const depRes = await this.pool.query<{ status: string }>(
      `SELECT status FROM deployments WHERE id = $1`,
      [deploymentId]
    );
    const dep = depRes.rows[0];
    if (!dep) {
      throw new ApiError(404, "NOT_FOUND", `배포 ID ${deploymentId}를 찾을 수 없습니다.`);
    }
    if (!EDITABLE_STATUSES.has(dep.status)) {
      throw new ApiError(
        409,
        "IR_NOT_EDITABLE",
        `${dep.status} 상태에서는 IR을 수정할 수 없습니다.`,
        "awaiting_target_confirmation 상태일 때 수정하세요."
      );
    }

    // 2. 현재 최신 버전 조회
    const versionRes = await this.pool.query<{ id: number; ir_json: Record<string, unknown>; row_num: number }>(
      `SELECT id, ir_json,
              ROW_NUMBER() OVER (ORDER BY id ASC) AS row_num
       FROM ir_versions
       WHERE deployment_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [deploymentId]
    );
    const current = versionRes.rows[0];
    if (!current) {
      throw new ApiError(404, "NOT_FOUND", `배포 ID ${deploymentId}의 IR이 없습니다.`);
    }

    if (current.row_num !== requestedVersion) {
      throw new ApiError(
        409,
        "IR_VERSION_CONFLICT",
        `IR 버전 불일치. 현재 버전: ${current.row_num}, 요청 버전: ${requestedVersion}.`,
        "GET /ir 로 최신 version을 조회한 뒤 재시도하세요."
      );
    }

    // 3. deep merge (shallow-merge for now; array fields replace per U-08 미결)
    const merged = deepMerge(current.ir_json, irPartial as Record<string, unknown>);

    // 4. IrSchema 검증
    const parsed = IrSchema.safeParse(merged);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new ApiError(400, "VALIDATION_ERROR", `IR 스키마 오류: ${msg}`, "IR 필드를 확인하세요.");
    }

    // 5. 새 ir_versions row 생성
    const insertRes = await this.pool.query<IrVersionRow>(
      `INSERT INTO ir_versions (deployment_id, ir_json, source)
       VALUES ($1, $2, 'user_edited')
       RETURNING id, deployment_id, ir_json, source, created_at`,
      [deploymentId, JSON.stringify(parsed.data)]
    );
    const newRow = insertRes.rows[0]!;
    const newVersion = current.row_num + 1;

    return this.toDto(newRow, newVersion);
  }

  async createFromAnalysis(deploymentId: number, irJson: Record<string, unknown>) {
    const res = await this.pool.query<IrVersionRow>(
      `INSERT INTO ir_versions (deployment_id, ir_json, source)
       VALUES ($1, $2, 'analyzer')
       RETURNING id, deployment_id, ir_json, source, created_at`,
      [deploymentId, JSON.stringify(irJson)]
    );
    return res.rows[0]!;
  }

  private toDto(row: IrVersionRow, version: number) {
    return {
      deploymentId: String(row.deployment_id),
      ir: row.ir_json,
      version,
      generatedAt: row.created_at.toISOString(),
      source: row.source,
    };
  }
}

function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(patch)) {
    if (
      val !== null &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        val as Record<string, unknown>
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}
