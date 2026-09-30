/**
 * apps/api/src/services/ai-usage-service.ts
 * API-32 AI 사용량 조회. `ai_usage` 테이블을 배포별로 GROUP BY model 집계.
 */

import type { Pool } from "@camellia/db";
import { ApiError } from "../plugins/error-handler.js";

export type AiUsageBreakdown = {
  model: string;
  tokenIn: number;
  tokenOut: number;
  costUsd: number;
};

export type AiUsageResponse = {
  deploymentId: number;
  totalTokenIn: number;
  totalTokenOut: number;
  totalCostUsd: number;
  breakdown: AiUsageBreakdown[];
};

export class AiUsageService {
  constructor(private readonly pool: Pool) {}

  async aggregate(deploymentId: number): Promise<AiUsageResponse> {
    const depCheck = await this.pool.query(
      `SELECT 1 FROM deployments WHERE id = $1`,
      [deploymentId],
    );
    if (depCheck.rowCount === 0) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        `배포 ID ${deploymentId}를 찾을 수 없습니다.`,
      );
    }

    const res = await this.pool.query<{
      model: string;
      token_in: string;
      token_out: string;
      cost_usd: string;
    }>(
      `SELECT model,
              COALESCE(SUM(input_tokens), 0)::text AS token_in,
              COALESCE(SUM(output_tokens), 0)::text AS token_out,
              COALESCE(SUM(estimated_cost_usd), 0)::text AS cost_usd
       FROM ai_usage
       WHERE deployment_id = $1
       GROUP BY model
       ORDER BY model`,
      [deploymentId],
    );

    const breakdown: AiUsageBreakdown[] = res.rows.map((r) => ({
      model: r.model,
      tokenIn: Number(r.token_in ?? 0),
      tokenOut: Number(r.token_out ?? 0),
      costUsd: Number(r.cost_usd ?? 0),
    }));

    const totalTokenIn = breakdown.reduce((s, b) => s + b.tokenIn, 0);
    const totalTokenOut = breakdown.reduce((s, b) => s + b.tokenOut, 0);
    const totalCostUsd = breakdown.reduce((s, b) => s + b.costUsd, 0);

    return {
      deploymentId,
      totalTokenIn,
      totalTokenOut,
      totalCostUsd,
      breakdown,
    };
  }
}
