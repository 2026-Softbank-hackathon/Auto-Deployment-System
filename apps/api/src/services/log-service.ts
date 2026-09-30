/**
 * apps/api/src/services/log-service.ts
 * API-12 배포 로그 조회.
 * LOG-02: 워커가 남긴 단계 로그 파일(logs/deployments/{id}/{step}.log)을 우선 반환하고,
 * 없으면 deployment_steps.message 요약을 반환한다.
 * P0: stream=false만 지원 (실시간은 /events SSE의 log.line 이벤트).
 */

import type { Pool } from "@camellia/db";
import type { Storage } from "@camellia/storage";
import { ApiError } from "../plugins/error-handler.js";

export const VALID_STEPS = ["analyze", "build", "provision", "verify"] as const;
export type ValidStep = (typeof VALID_STEPS)[number];

export type LogResult =
  | { hasContent: false }
  | { hasContent: true; text: string };

/** apps/worker/src/step-log.ts 의 stepLogKey 와 같은 규칙. */
function stepLogKey(deploymentId: number, step: ValidStep): string {
  return `logs/deployments/${deploymentId}/${step}.log`;
}

export class LogService {
  constructor(
    private readonly pool: Pool,
    private readonly storage: Storage,
  ) {}

  async get(
    deploymentId: number,
    step: ValidStep,
    tail?: number,
  ): Promise<LogResult> {
    const depCheck = await this.pool.query(
      `SELECT 1 FROM deployments WHERE id = $1`,
      [deploymentId],
    );
    if (depCheck.rows.length === 0) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        `배포 ID ${deploymentId}를 찾을 수 없습니다.`,
      );
    }

    let text = await this.readStepLog(deploymentId, step);
    if (text === null) {
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

      text = messages.join("\n");
    }

    if (tail !== undefined && tail > 0) {
      const lines = text.split("\n");
      text = lines.slice(-tail).join("\n");
    }

    return { hasContent: true, text };
  }

  private async readStepLog(deploymentId: number, step: ValidStep): Promise<string | null> {
    const key = stepLogKey(deploymentId, step);
    if (!(await this.storage.exists(key))) return null;
    const text = (await this.storage.get(key)).toString("utf8").trimEnd();
    return text.length > 0 ? text : null;
  }
}
