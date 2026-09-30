/**
 * apps/api/src/services/env-var-service.ts
 * DAT-01 프로젝트 환경변수 — 평문 설정값. 다음 배포부터 적용된다.
 * 민감한 값은 SecretService (DAT-02) 를 사용한다.
 */

import type { Pool } from "@camellia/db";
import { ApiError } from "../plugins/error-handler.js";

type EnvVarRow = { name: string; value: string; updated_at: Date };

export type EnvVarList = {
  items: { name: string; value: string; updatedAt: string }[];
};

export class EnvVarService {
  constructor(private readonly pool: Pool) {}

  async list(projectId: number): Promise<EnvVarList> {
    await this.assertProject(projectId);
    return this.select(projectId);
  }

  /** vars 의 값이 문자열이면 추가·덮어쓰기, null 이면 삭제. 한 트랜잭션으로 반영한다. */
  async update(projectId: number, vars: Record<string, string | null>): Promise<EnvVarList> {
    await this.assertProject(projectId);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const [name, value] of Object.entries(vars)) {
        if (value === null) {
          await client.query(`DELETE FROM env_vars WHERE project_id = $1 AND name = $2`, [
            projectId,
            name,
          ]);
        } else {
          await client.query(
            `INSERT INTO env_vars (project_id, name, value)
             VALUES ($1, $2, $3)
             ON CONFLICT (project_id, name)
             DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [projectId, name, value],
          );
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return this.select(projectId);
  }

  private async assertProject(projectId: number) {
    const res = await this.pool.query(`SELECT 1 FROM projects WHERE id = $1`, [projectId]);
    if (res.rows.length === 0) {
      throw new ApiError(404, "NOT_FOUND", `프로젝트 ID ${projectId}를 찾을 수 없습니다.`, "ID를 확인하세요.");
    }
  }

  private async select(projectId: number): Promise<EnvVarList> {
    const res = await this.pool.query<EnvVarRow>(
      `SELECT name, value, updated_at FROM env_vars
       WHERE project_id = $1
       ORDER BY name`,
      [projectId],
    );
    return {
      items: res.rows.map((r) => ({
        name: r.name,
        value: r.value,
        updatedAt: r.updated_at.toISOString(),
      })),
    };
  }
}
