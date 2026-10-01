/**
 * apps/api/tests/secret-service.test.ts
 * 유닛 테스트 (mock pool + 실 crypto).
 * - AES-256-GCM 암호화 → decrypt roundtrip
 * - 응답에 value 필드 없음
 * - 이름 중복 → 409
 */

import { describe, it, expect, vi } from "vitest";
import type { Pool } from "@camellia/db";
import { SecretService } from "../src/services/secret-service.js";

type Handler = (sql: string, params: unknown[]) => { rows: unknown[]; rowCount: number };

function mockPool(): { pool: Pool; addHandler: (h: Handler) => void; calls: Array<{ sql: string; params: unknown[] }> } {
  const handlers: Handler[] = [];
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    for (const h of handlers) {
      const res = h(sql, params);
      if (res.rowCount > 0 || res.rows.length >= 0) return res;
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    pool: { query } as unknown as Pool,
    addHandler: (h) => handlers.push(h),
    calls,
  };
}

const MASTER_KEY = Buffer.alloc(32, 0xab);

describe("SecretService", () => {
  it("생성 → 저장된 row 를 decrypt 하면 원문이 나온다 (roundtrip)", async () => {
    let stored: { ciphertext: Buffer; iv: Buffer; auth_tag: Buffer } | null = null;
    const { pool } = mockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes("SELECT 1 FROM projects")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("INSERT INTO secrets")) {
        stored = { ciphertext: params[2] as Buffer, iv: params[3] as Buffer, auth_tag: params[4] as Buffer };
        return { rows: [{ created_at: new Date("2026-09-30T09:00:00Z") }], rowCount: 1 };
      }
      if (sql.includes("SELECT ciphertext, iv, auth_tag")) {
        return { rows: [stored], rowCount: stored ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    const svc = new SecretService(pool, MASTER_KEY);
    const dto = await svc.create({ projectId: 1, name: "aws-key-1", value: "AKIA_TOP_SECRET_VALUE" });
    expect(dto.name).toBe("aws-key-1");
    expect(dto.projectId).toBe(1);
    expect(dto).not.toHaveProperty("value");

    const plain = await svc.decrypt({ projectId: 1, name: "aws-key-1" });
    expect(plain).toBe("AKIA_TOP_SECRET_VALUE");
  });

  it("응답 · calls 어디에도 value 원문이 노출되지 않는다", async () => {
    const { pool, calls } = mockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes("SELECT 1 FROM projects")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("INSERT INTO secrets"))
        return { rows: [{ created_at: new Date() }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const svc = new SecretService(pool, MASTER_KEY);
    const SECRET = "PLAINTEXT_SECRET_XYZ_MUST_NOT_APPEAR";
    const dto = await svc.create({ projectId: 1, name: "x", value: SECRET });
    expect(JSON.stringify(dto)).not.toContain(SECRET);
    // INSERT 파라미터에도 원문이 없어야 함 (ciphertext bytea 로만)
    const insert = calls.find((c) => c.sql.includes("INSERT INTO secrets"));
    expect(insert).toBeDefined();
    const paramsStr = insert!.params.map((p) => (Buffer.isBuffer(p) ? p.toString("hex") : String(p))).join("|");
    expect(paramsStr).not.toContain(SECRET);
  });

  it("이름 중복 시 409", async () => {
    const { pool } = mockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT 1 FROM projects")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("INSERT INTO secrets")) {
        throw new Error('duplicate key value violates unique constraint "secrets_project_id_name_key"');
      }
      return { rows: [], rowCount: 0 };
    });
    const svc = new SecretService(pool, MASTER_KEY);
    await expect(svc.create({ projectId: 1, name: "dup", value: "v" })).rejects.toMatchObject({
      statusCode: 409,
      code: "CONFLICT",
    });
  });

  it("list 는 이름만 반환한다 (value 없음)", async () => {
    const { pool } = mockPool();
    (pool.query as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT name, project_id, created_at FROM secrets")) {
        return {
          rows: [
            { name: "aws-key-1", project_id: 1, created_at: new Date("2026-09-30T09:00:00Z") },
            { name: "aws-secret-1", project_id: 1, created_at: new Date("2026-09-30T09:01:00Z") },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const svc = new SecretService(pool, MASTER_KEY);
    const list = await svc.list({ projectId: 1 });
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ name: "aws-key-1", projectId: 1, createdAt: "2026-09-30T09:00:00.000Z" });
    expect(list[0]).not.toHaveProperty("value");
  });

  it("AWS Environment가 참조하는 시크릿은 삭제하지 않는다", async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM environments")) return { rows: [{ id: 10 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Pool;
    const svc = new SecretService(pool, MASTER_KEY);

    await expect(
      svc.delete({ projectId: 1, name: "aws-secret" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "SECRET_IN_USE" });
    expect(queries.some((sql) => sql.includes("DELETE FROM secrets"))).toBe(false);
  });

  it("AWS Environment에서 참조하지 않는 시크릿은 삭제한다", async () => {
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM environments")) return { rows: [], rowCount: 0 };
        if (sql.includes("DELETE FROM secrets")) return { rows: [], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Pool;
    const svc = new SecretService(pool, MASTER_KEY);

    await expect(
      svc.delete({ projectId: 1, name: "unused" }),
    ).resolves.toBeUndefined();
    expect(queries.some((sql) => sql.includes("DELETE FROM secrets"))).toBe(true);
  });

  it("잘못된 masterKey 길이는 즉시 실패", () => {
    expect(() => new SecretService({} as Pool, Buffer.alloc(16))).toThrow(/32바이트/);
  });
});
