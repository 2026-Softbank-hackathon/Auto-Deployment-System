/**
 * apps/api/tests/mocks/db.ts
 * In-memory Pool mock + PgBoss mock.
 * 테스트 격리용 — 실제 Postgres 불필요.
 */

import type { Pool, PoolClient } from "pg";
import type PgBoss from "pg-boss";

type Row = Record<string, unknown>;

/**
 * 간단한 in-memory 쿼리 라우터.
 * 테스트에서 handlers를 등록하면 SQL 패턴에 맞는 핸들러가 실행된다.
 */
export class MockPool {
  private handlers: Array<{
    pattern: RegExp;
    handler: (params: unknown[]) => { rows: Row[] };
  }> = [];

  private clients: MockClient[] = [];

  on(pattern: RegExp, handler: (params: unknown[]) => { rows: Row[] }) {
    this.handlers.push({ pattern, handler });
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    for (const { pattern, handler } of this.handlers) {
      if (pattern.test(normalized)) {
        return handler(params);
      }
    }
    return { rows: [] };
  }

  async connect(): Promise<MockClient> {
    const client = new MockClient(this);
    this.clients.push(client);
    return client;
  }

  reset() {
    this.handlers = [];
    this.clients = [];
  }
}

export class MockClient {
  private pool: MockPool;
  private released = false;

  constructor(pool: MockPool) {
    this.pool = pool;
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    return this.pool.query(sql, params);
  }

  release() {
    this.released = true;
  }
}

export class MockPgBoss {
  public sentJobs: Array<{ name: string; data: unknown }> = [];

  async start() {
    // no-op
  }

  async send(name: string, data: unknown) {
    this.sentJobs.push({ name, data });
    return null;
  }

  async stop() {
    // no-op
  }

  reset() {
    this.sentJobs = [];
  }
}

export class MockStorage {
  public store = new Map<string, Buffer>();

  async put(key: string, data: Buffer): Promise<void> {
    this.store.set(key, data);
  }

  async get(key: string): Promise<Buffer | null> {
    return this.store.get(key) ?? null;
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  reset() {
    this.store.clear();
  }
}
