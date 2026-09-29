/**
 * apps/worker/tests/state-machine.test.ts
 *
 * 상태 전이 유효성 테스트 — Postgres 없이 MockPool로만 실행.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { transitionTo, VALID_TRANSITIONS } from "../src/state-machine.js";
import type { Status } from "../src/state-machine.js";

// ---------------------------------------------------------------------------
// MockPool 구현
// ---------------------------------------------------------------------------

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

function makeMockPool(currentStatus: string, shouldFailQuery = false) {
  const queries: Array<{ sql: string; params?: unknown[] }> = [];

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (shouldFailQuery && sql.includes("SELECT status")) {
        throw new Error("db error");
      }
      if (sql.includes("SELECT status")) {
        return { rows: [{ status: currentStatus }] };
      }
      return { rows: [] };
    }) as QueryFn,
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rows: [] })),
  };

  return { pool, client, queries };
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe("state-machine: transitionTo", () => {
  it("유효 전이 성공 — received → analyzing", async () => {
    const { pool, client } = makeMockPool("received");

    await transitionTo(pool as any, 1, "analyzing");

    // BEGIN, SELECT ... FOR UPDATE, UPDATE, COMMIT 순서
    const calls = client.query.mock.calls.map((c) => (c[0] as string).trim().split(/\s+/)[0]);
    expect(calls).toContain("BEGIN");
    expect(calls).toContain("SELECT");
    expect(calls).toContain("UPDATE");
    expect(calls).toContain("COMMIT");
  });

  it("유효 전이 성공 — analyzing → awaiting_target_confirmation", async () => {
    const { pool } = makeMockPool("analyzing");
    await expect(
      transitionTo(pool as any, 2, "awaiting_target_confirmation")
    ).resolves.toBeUndefined();
  });

  it("무효 전이 throw — succeeded → analyzing", async () => {
    const { pool } = makeMockPool("succeeded");
    await expect(
      transitionTo(pool as any, 3, "analyzing")
    ).rejects.toThrow(/invalid transition/);
  });

  it("무효 전이 throw — succeeded → received", async () => {
    const { pool } = makeMockPool("succeeded");
    await expect(
      transitionTo(pool as any, 4, "received")
    ).rejects.toThrow(/invalid transition/);
  });

  it("failed는 received에서 허용", async () => {
    const { pool } = makeMockPool("received");
    await expect(
      transitionTo(pool as any, 5, "failed")
    ).resolves.toBeUndefined();
  });

  it("failed는 analyzing에서 허용", async () => {
    const { pool } = makeMockPool("analyzing");
    await expect(
      transitionTo(pool as any, 6, "failed")
    ).resolves.toBeUndefined();
  });

  it("failed는 deploying에서 허용", async () => {
    const { pool } = makeMockPool("deploying");
    await expect(
      transitionTo(pool as any, 7, "failed")
    ).resolves.toBeUndefined();
  });

  it("deployment가 없으면 throw", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT status")) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };
    await expect(
      transitionTo(pool as any, 999, "analyzing")
    ).rejects.toThrow(/not found/);
  });

  it("VALID_TRANSITIONS 구조 — succeeded는 빈 배열", () => {
    const successorStatuses: Status[] = VALID_TRANSITIONS["succeeded"];
    expect(successorStatuses).toEqual([]);
  });
});
