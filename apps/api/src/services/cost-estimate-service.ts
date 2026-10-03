/**
 * apps/api/src/services/cost-estimate-service.ts
 * GET /deployments/:id/cost-estimate (#327). 배포의 프로필 · 최신 IR(서비스 size · PostgreSQL 유무)로 월 예상 비용을 계산한다.
 */

import type { Pool } from "@camellia/db";
import type { DeploymentCostEstimate } from "@camellia/contracts";
import { estimateMonthlyCost, getProfile } from "@camellia/profiles";
import { ApiError } from "../plugins/error-handler.js";

type IrLike = {
  services?: Record<string, { size?: unknown }>;
  resources?: Record<string, { type?: unknown }>;
};

export class CostEstimateService {
  constructor(private readonly pool: Pool) {}

  async estimate(deploymentId: number): Promise<DeploymentCostEstimate> {
    const dep = await this.pool.query<{ target_profile: string | null }>(
      `SELECT target_profile FROM deployments WHERE id = $1`,
      [deploymentId],
    );
    const row = dep.rows[0];
    if (!row) {
      throw new ApiError(404, "NOT_FOUND", `배포 ID ${deploymentId}를 찾을 수 없습니다.`);
    }
    const profile = row.target_profile ? getProfile(row.target_profile) : null;
    const base = { deploymentId: String(deploymentId), targetProfile: row.target_profile };
    if (!profile) return { ...base, estimate: null };

    const irRes = await this.pool.query<{ ir_json: IrLike }>(
      `SELECT ir_json FROM ir_versions WHERE deployment_id = $1 ORDER BY id DESC LIMIT 1`,
      [deploymentId],
    );
    const ir = irRes.rows[0]?.ir_json;
    if (!ir) return { ...base, estimate: null };

    const firstService = Object.values(ir.services ?? {})[0];
    const size = typeof firstService?.size === "string" ? firstService.size : "small";
    const database = Object.values(ir.resources ?? {}).some((resource) => resource?.type === "postgres");
    return { ...base, estimate: estimateMonthlyCost({ profile, size, database }) };
  }
}
