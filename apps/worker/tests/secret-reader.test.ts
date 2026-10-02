import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Pool } from "@camellia/db";
import {
  decodeWorkerSecretMasterKey,
  PostgresProjectSecretReader,
} from "../src/secret-reader.js";

describe("PostgresProjectSecretReader", () => {
  it("Secret API와 같은 AES-256-GCM 형식을 복호화한다", async () => {
    const masterKey = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update("secret-value", "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ ciphertext, iv, auth_tag: authTag }],
      })),
    } as unknown as Pool;

    const value = await new PostgresProjectSecretReader(pool, masterKey).read(
      1,
      "aws-secret",
    );

    expect(value).toBe("secret-value");
    expect(pool.query).toHaveBeenCalledWith(expect.any(String), [1, "aws-secret"]);
  });

  it("소유 범위가 null 이면 공용 시크릿(project_id IS NULL)에서 읽는다 (#215)", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;

    await expect(
      new PostgresProjectSecretReader(pool, randomBytes(32)).read(null, "aws-secret"),
    ).rejects.toThrow("PROJECT_SECRET_NOT_FOUND");

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("project_id IS NOT DISTINCT FROM $1::bigint"),
      [null, "aws-secret"],
    );
  });

  it("없는 Secret과 잘못된 master key를 값 없는 오류로 반환한다", async () => {
    const emptyPool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;
    await expect(
      new PostgresProjectSecretReader(emptyPool, randomBytes(32)).read(1, "x"),
    ).rejects.toThrow("PROJECT_SECRET_NOT_FOUND");

    const encrypted = {
      ciphertext: Buffer.from("ciphertext"),
      iv: randomBytes(12),
      auth_tag: randomBytes(16),
    };
    const invalidPool = {
      query: vi.fn(async () => ({ rows: [encrypted] })),
    } as unknown as Pool;
    await expect(
      new PostgresProjectSecretReader(invalidPool, randomBytes(32)).read(1, "x"),
    ).rejects.toThrow("PROJECT_SECRET_DECRYPT_FAILED");
  });
});

describe("decodeWorkerSecretMasterKey", () => {
  it("32바이트 base64만 허용한다", () => {
    const key = randomBytes(32);
    expect(decodeWorkerSecretMasterKey(key.toString("base64"))).toEqual(key);
    expect(() => decodeWorkerSecretMasterKey(undefined)).toThrow(
      "SECRET_MASTER_KEY is required",
    );
    expect(() =>
      decodeWorkerSecretMasterKey(Buffer.alloc(8).toString("base64")),
    ).toThrow("SECRET_MASTER_KEY must be base64-encoded 32 bytes");
  });
});
