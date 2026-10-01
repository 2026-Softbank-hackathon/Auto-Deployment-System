/**
 * apps/api/src/services/secret-service.ts
 * API-28/29/30 (DAT-02) — AES-256-GCM 로 시크릿 값을 암호화해 저장하고, 이름만으로 노출.
 *
 * 저장: value → { ciphertext, iv(12B), authTag(16B) } · 원시 value 는 응답/로그 어디에도 없음
 * 복호화: 워커가 배포 시점에만 호출 (decrypt · 이 이슈 스코프 밖)
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Pool } from "@camellia/db";
import type { Secret } from "@camellia/contracts";
import { ApiError } from "../plugins/error-handler.js";

export type SecretDto = Secret;

export class SecretService {
  constructor(
    private readonly pool: Pool,
    private readonly masterKey: Buffer,
  ) {
    if (masterKey.length !== 32) {
      throw new Error("SECRET_MASTER_KEY 는 32바이트 (base64 디코딩 기준) 여야 합니다.");
    }
  }

  async create(input: { projectId: number; name: string; value: string }): Promise<SecretDto> {
    const proj = await this.pool.query(`SELECT 1 FROM projects WHERE id = $1`, [input.projectId]);
    if (proj.rowCount === 0) {
      throw new ApiError(404, "NOT_FOUND", `프로젝트 ID ${input.projectId}를 찾을 수 없습니다.`);
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    try {
      const res = await this.pool.query<{ created_at: Date }>(
        `INSERT INTO secrets (project_id, name, ciphertext, iv, auth_tag)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING created_at`,
        [input.projectId, input.name, ciphertext, iv, authTag],
      );
      return {
        name: input.name,
        projectId: input.projectId,
        createdAt: res.rows[0]!.created_at.toISOString(),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/unique|duplicate/i.test(msg)) {
        throw new ApiError(
          409,
          "CONFLICT",
          `시크릿 이름 '${input.name}' 이 프로젝트 ${input.projectId} 에 이미 존재합니다.`,
        );
      }
      throw e;
    }
  }

  async list(input: { projectId: number }): Promise<SecretDto[]> {
    const res = await this.pool.query<{ name: string; project_id: number; created_at: Date }>(
      `SELECT name, project_id, created_at FROM secrets
       WHERE project_id = $1 ORDER BY name`,
      [input.projectId],
    );
    return res.rows.map((r) => ({
      name: r.name,
      projectId: r.project_id,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async delete(input: { projectId: number; name: string }): Promise<void> {
    const references = await this.pool.query<{ id: number }>(
      `SELECT id
       FROM environments
       WHERE project_id = $1
         AND type = 'aws'
         AND (
           aws_config ->> 'accessKeyIdSecretName' = $2
           OR aws_config ->> 'secretAccessKeySecretName' = $2
         )
       LIMIT 1`,
      [input.projectId, input.name],
    );
    if (references.rows.length > 0) {
      throw new ApiError(
        409,
        "SECRET_IN_USE",
        `시크릿 '${input.name}' 이 AWS Environment에서 사용 중입니다.`,
        "해당 Environment의 자격증명 참조를 변경한 뒤 삭제하세요.",
      );
    }

    const res = await this.pool.query(
      `DELETE FROM secrets WHERE project_id = $1 AND name = $2`,
      [input.projectId, input.name],
    );
    if (res.rowCount === 0) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        `시크릿 '${input.name}' 이 프로젝트 ${input.projectId} 에 없습니다.`,
      );
    }
  }

  /** 워커에서만 호출 (배포 시점 AWS 인증 등). 이 이슈에서는 라우트로 노출 안 함. */
  async decrypt(input: { projectId: number; name: string }): Promise<string> {
    const res = await this.pool.query<{ ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }>(
      `SELECT ciphertext, iv, auth_tag FROM secrets
       WHERE project_id = $1 AND name = $2`,
      [input.projectId, input.name],
    );
    const row = res.rows[0];
    if (!row) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        `시크릿 '${input.name}' 이 프로젝트 ${input.projectId} 에 없습니다.`,
      );
    }
    const decipher = createDecipheriv("aes-256-gcm", this.masterKey, row.iv);
    decipher.setAuthTag(row.auth_tag);
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
  }
}
