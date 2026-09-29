/**
 * apps/api/tests/pg-listener.test.ts
 *
 * pg-listener 단위 테스트 — mock Pool로 notification 콜백 시뮬레이션.
 * 실제 Postgres 연결 없이 동작한다.
 */

import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { startPgListener } from "../src/plugins/pg-listener.js";
import type { Pool } from "@camellia/db";

// ── mock pool helpers ─────────────────────────────────────────────────────────

/**
 * EventEmitter를 기반으로 한 mock PoolClient.
 * startPgListener 내부에서 connect() → LISTEN query → client.on("notification") 순서를 재현.
 */
function makeMockPool(client: MockPoolClient): Pool {
  return {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

class MockPoolClient extends EventEmitter {
  public queries: string[] = [];
  public released = false;

  async query(sql: string) {
    this.queries.push(sql.trim());
    return { rows: [] };
  }

  release() {
    this.released = true;
  }
}

// ── 테스트 1: 기본 채널에서 JSON 페이로드를 파싱해 onNotification 호출 ──────

describe("startPgListener", () => {
  it("default channel - parses JSON payload and calls onNotification", async () => {
    const client = new MockPoolClient();
    const pool = makeMockPool(client);
    const received: unknown[] = [];

    const unsub = await startPgListener(pool, {
      onNotification: (p) => received.push(p),
    });

    // LISTEN 쿼리가 실행됐는지 확인
    expect(client.queries).toContain('LISTEN "deployment_events"');

    // notification 시뮬레이션
    const msg = {
      channel: "deployment_events",
      payload: JSON.stringify({ deployment_id: 42, event: "state_changed", payload: { status: "analyzing" } }),
    };
    client.emit("notification", msg);

    expect(received).toHaveLength(1);
    expect((received[0] as Record<string, unknown>)["deployment_id"]).toBe(42);
    expect((received[0] as Record<string, unknown>)["event"]).toBe("state_changed");

    await unsub();
    expect(client.released).toBe(true);
    // UNLISTEN 쿼리 확인
    expect(client.queries.some((q) => q.startsWith("UNLISTEN"))).toBe(true);
  });

  // ── 테스트 2: 다른 채널의 알림은 무시된다 ────────────────────────────────

  it("ignores notifications from other channels", async () => {
    const client = new MockPoolClient();
    const pool = makeMockPool(client);
    const received: unknown[] = [];

    const unsub = await startPgListener(pool, {
      channel: "deployment_events",
      onNotification: (p) => received.push(p),
    });

    // wrong channel — should be ignored
    client.emit("notification", {
      channel: "other_channel",
      payload: JSON.stringify({ deployment_id: 1, event: "test" }),
    });

    expect(received).toHaveLength(0);

    await unsub();
  });

  // ── 테스트 3: 잘못된 JSON은 원문 문자열로 전달된다 ───────────────────────

  it("passes raw string when payload is not valid JSON", async () => {
    const client = new MockPoolClient();
    const pool = makeMockPool(client);
    const received: unknown[] = [];

    const unsub = await startPgListener(pool, {
      onNotification: (p) => received.push(p),
    });

    client.emit("notification", {
      channel: "deployment_events",
      payload: "not-json{{",
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toBe("not-json{{");

    await unsub();
  });

  // ── 테스트 4: unsub 후에는 알림이 전달되지 않는다 ──────────────────────

  it("stops delivering notifications after unsubscribe", async () => {
    const client = new MockPoolClient();
    const pool = makeMockPool(client);
    const received: unknown[] = [];

    const unsub = await startPgListener(pool, {
      onNotification: (p) => received.push(p),
    });

    await unsub();

    client.emit("notification", {
      channel: "deployment_events",
      payload: JSON.stringify({ deployment_id: 1, event: "state_changed" }),
    });

    expect(received).toHaveLength(0);
  });
});
