/**
 * apps/api/src/services/diagnosis-service.ts
 * API-36 AI 실패 진단 조회. `deployments.diagnosis_json` 을 읽어 DTO 로 변환.
 */

import type { Pool } from "@camellia/db";
import type { Diagnosis, LocalizedText, PatchCandidate } from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";

export type { PatchCandidate };
export type DiagnosisResponse = Diagnosis;

/** 워커가 저장한 형식. *I18n 은 #147 이후 진단에만 있다 */
type StoredDiagnosis = {
  failedStep: string | null;
  summary: string;
  summaryI18n?: LocalizedText;
  patchCandidates: PatchCandidate[];
  generatedAt: string;
};

export class DiagnosisService {
  constructor(private readonly pool: Pool) {}

  async get(deploymentId: number): Promise<DiagnosisResponse> {
    const res = await this.pool.query<{ diagnosis_json: StoredDiagnosis | null }>(
      `SELECT diagnosis_json FROM deployments WHERE id = $1`,
      [deploymentId],
    );
    const row = res.rows[0];
    if (!row) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        `배포 ID ${deploymentId}를 찾을 수 없습니다.`,
      );
    }
    if (!row.diagnosis_json) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        `배포 ID ${deploymentId}의 진단 결과가 아직 없습니다.`,
        "배포 실패 후 잠시 뒤 다시 조회하세요.",
      );
    }
    const d = row.diagnosis_json;
    return {
      deploymentId,
      failedStep: d.failedStep ?? null,
      summary: d.summary ?? "",
      ...(d.summaryI18n ? { summaryI18n: d.summaryI18n } : {}),
      patchCandidates: Array.isArray(d.patchCandidates) ? d.patchCandidates : [],
      generatedAt: d.generatedAt,
    };
  }
}
