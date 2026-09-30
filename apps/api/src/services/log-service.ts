/**
 * apps/api/src/services/log-service.ts
 * API-12 배포 로그 조회 (deployment_steps.message 조회).
 * P0: stream=false만 지원.
 */

import type { Pool } from "@camellia/db";
import { ApiError } from "../plugins/error-handler.js";

export const VALID_STEPS = ["analyze", "build", "provision", "verify"] as const;
export type ValidStep = (typeof VALID_STEPS)[number];

export type LogResult =
  | { hasContent: false }
  | { hasContent: true; text: string };

export class LogService {
  constructor(private readonly pool: Pool) {}

  async get(
    deploymentId: number,
    step: ValidStep,
    tail?: number,
  ): Promise<LogResult> {
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

    const res = await this.pool.query<{ message: string | null }>(
      `SELECT message FROM deployment_steps
       WHERE deployment_id = $1 AND step_name = $2
       ORDER BY id`,
      [deploymentId, step],
    );

    const messages: string[] = [];
    for (const row of res.rows) {
      if (row.message !== null && row.message.length > 0) {
        messages.push(row.message);
      }
    }

    if (messages.length === 0) {
      return { hasContent: false };
    }

    let text = messages.join("\n");
    if (tail !== undefined && tail > 0) {
      const lines = text.split("\n");
      text = lines.slice(-tail).join("\n");
    }

    return { hasContent: true, text };
  }
}
