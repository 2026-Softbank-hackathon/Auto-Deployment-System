/**
 * apps/api/tests/audit-log-service.test.ts
 * AuditLogService 유닛 테스트 (mock pool).
 *
 * - record() → INSERT 호출 확인
 * - list() — 기본 조회
 * - list() — actor 필터
 * - list() — resource 필터
 * - list() — cursor 페이지네이션
 * - list() — nextCursor 없을 때 null
 * - list() — nextCursor 있을 때 base64url 인코딩된 값
 */

import { describe, it, expect, vi } from "vitest";
import type { Pool } from "@camellia/db";
import { AuditLogService } from "../src/services/audit-log-service.js";

function makePool(
  fn: (sql: string, params: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>,
): Pool {
  return { query: vi.fn(fn) } as unknown as Pool;
}

const SAMPLE_ROW = {
  id: "1",
  actor_type: "session",
  actor_id: "abc123…",
  action: "POST /deployments",
  resource_type: "deployment",
  resource_id: "42",
  status_code: 201,
  request_id: "req_abc",
  metadata: { name: "my-app" },
  created_at: new Date("2026-10-01T00:00:00.000Z"),
};

// ── record ────────────────────────────────────────────────────────────────────

describe("AuditLogService.record", () => {
  it("INSERT INTO audit_logs 호출", async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const svc = new AuditLogService(pool);

    await svc.record({
      actorType: "session",
      actorId: "abc123…",
      action: "POST /deployments",
      resourceType: "deployment",
      resourceId: "42",
      statusCode: 201,
      requestId: "req_abc",
      metadata: { name: "my-app" },
    });

    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO audit_logs/i);
    expect(params[0]).toBe("session");
    expect(params[2]).toBe("POST /deployments");
    expect(params[5]).toBe(201);
  });

  it("metadata 없으면 null 전달", async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const svc = new AuditLogService(pool);

    await svc.record({
      actorType: "system",
      actorId: null,
      action: "DELETE /secrets/mykey",
      resourceType: "secret",
      resourceId: null,
      statusCode: 204,
      requestId: "req_del",
      metadata: null,
    });

    const [, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(params[7]).toBeNull();
  });
});

// ── list ──────────────────────────────────────────────────────────────────────

describe("AuditLogService.list", () => {
  it("기본 조회 — items 반환, nextCursor null", async () => {
    const pool = makePool(async (sql) => {
      if (/FROM audit_logs/i.test(sql)) {
        return { rows: [SAMPLE_ROW] };
      }
      return { rows: [] };
    });
    const svc = new AuditLogService(pool);

    const result = await svc.list({ limit: 50 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe("1");
    expect(result.items[0]!.actorType).toBe("session");
    expect(result.nextCursor).toBeNull();
  });

  it("actor 필터 — WHERE 절에 actor_type, actor_id 포함", async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const svc = new AuditLogService(pool);

    await svc.list({ actorType: "session", actorId: "abc", limit: 50 });

    const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/actor_type = \$/);
    expect(sql).toMatch(/actor_id = \$/);
    expect(params).toContain("session");
    expect(params).toContain("abc");
  });

  it("resource 필터 — WHERE 절에 resource_type, resource_id 포함", async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const svc = new AuditLogService(pool);

    await svc.list({ resourceType: "deployment", resourceId: "42", limit: 50 });

    const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/resource_type = \$/);
    expect(sql).toMatch(/resource_id = \$/);
    expect(params).toContain("deployment");
    expect(params).toContain("42");
  });

  it("nextCursor 있을 때 — limit+1 행 반환 시 초과분 pop + cursor 반환", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      ...SAMPLE_ROW,
      id: String(10 - i),
    }));
    const pool = makePool(async () => ({ rows }));
    const svc = new AuditLogService(pool);

    const result = await svc.list({ limit: 2 });

    expect(result.items).toHaveLength(2); // 초과분 제거됨
    expect(result.nextCursor).not.toBeNull();
    // nextCursor 는 base64url 디코딩하면 last id
    const decoded = Buffer.from(result.nextCursor!, "base64url").toString("utf8");
    expect(decoded).toBe("9"); // rows[1].id = "9"
  });

  it("cursor 전달 시 WHERE id < $N 포함", async () => {
    const cursor = Buffer.from("50", "utf8").toString("base64url");
    const pool = makePool(async () => ({ rows: [] }));
    const svc = new AuditLogService(pool);

    await svc.list({ limit: 50, cursor });

    const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/id < \$/);
    expect(params).toContain("50");
  });

  it("actionPrefix 필터 — LIKE $N 포함", async () => {
    const pool = makePool(async () => ({ rows: [] }));
    const svc = new AuditLogService(pool);

    await svc.list({ actionPrefix: "POST", limit: 50 });

    const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/action LIKE \$/);
    expect(params).toContain("POST%");
  });
});
