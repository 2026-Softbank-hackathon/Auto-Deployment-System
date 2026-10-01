import { createDecipheriv } from "node:crypto";
import type { Pool } from "@camellia/db";

export interface ProjectSecretReader {
  read(projectId: number, name: string): Promise<string>;
}

export class PostgresProjectSecretReader implements ProjectSecretReader {
  constructor(
    private readonly pool: Pool,
    private readonly masterKey: Buffer,
  ) {
    if (masterKey.length !== 32) {
      throw new Error("SECRET_MASTER_KEY must decode to 32 bytes");
    }
  }

  async read(projectId: number, name: string): Promise<string> {
    const result = await this.pool.query<{
      ciphertext: Buffer;
      iv: Buffer;
      auth_tag: Buffer;
    }>(
      `SELECT ciphertext, iv, auth_tag
       FROM secrets
       WHERE project_id = $1 AND name = $2`,
      [projectId, name],
    );
    const row = result.rows[0];
    if (!row) throw new Error("PROJECT_SECRET_NOT_FOUND");

    try {
      const decipher = createDecipheriv("aes-256-gcm", this.masterKey, row.iv);
      decipher.setAuthTag(row.auth_tag);
      return Buffer.concat([
        decipher.update(row.ciphertext),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("PROJECT_SECRET_DECRYPT_FAILED");
    }
  }
}

export function decodeWorkerSecretMasterKey(encoded: string | undefined): Buffer {
  if (!encoded) throw new Error("SECRET_MASTER_KEY is required");
  const value = encoded.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("SECRET_MASTER_KEY must be base64-encoded 32 bytes");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 32) {
    throw new Error("SECRET_MASTER_KEY must be base64-encoded 32 bytes");
  }
  return decoded;
}
