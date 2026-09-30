/**
 * tests/e2e/setup.ts
 *
 * e2e 테스트 전역 셋업:
 * 1. Postgres 컨테이너 연결 확인 (없으면 SKIP_E2E=true 설정)
 * 2. camellia_e2e DB 생성 (없으면)
 * 3. packages/db 마이그레이션 실행
 * 4. afterAll: 테이블 truncate
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Use createRequire to load CJS pg module without vite transformation
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pg = require("pg") as typeof import("pg");

const __dirname = dirname(fileURLToPath(import.meta.url));

// 환경변수 DATABASE_URL이 있으면 그걸 admin/base URL로 사용 (host/port/user 재활용)
// 없으면 5432 로컬 기본값
const BASE_URL = process.env["DATABASE_URL"] ?? "postgres://camellia:camellia@localhost:5432/camellia";
const ADMIN_DATABASE_URL = BASE_URL;
// e2e DB는 base URL의 DB 이름만 camellia_e2e로 교체
export const E2E_DATABASE_URL = BASE_URL.replace(/\/[^/?]+(\?|$)/, "/camellia_e2e$1");

const MIGRATIONS_DIR = join(__dirname, "../../packages/db/migrations");

// ── global flag ───────────────────────────────────────────────────────────────

/** true のとき Postgres が使えないので全テストを skip する */
export let postgresAvailable = false;

// ── helpers ───────────────────────────────────────────────────────────────────

async function checkPostgres(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: ADMIN_DATABASE_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function createE2eDb(): Promise<void> {
  const pool = new pg.Pool({ connectionString: ADMIN_DATABASE_URL });
  try {
    await pool.query("CREATE DATABASE camellia_e2e");
  } catch (err: unknown) {
    // DB가 이미 존재하면 무시
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already exists")) throw err;
  } finally {
    await pool.end().catch(() => {});
  }
}

async function runMigrations(): Promise<void> {
  const pool = new pg.Pool({ connectionString: E2E_DATABASE_URL });
  const client = await pool.connect();

  const TRACKING_DDL = `
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `;

  try {
    await client.query(TRACKING_DDL);

    const appliedRes = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name"
    );
    const applied = new Set(appliedRes.rows.map((r) => r.name));

    let entries: string[];
    try {
      entries = await readdir(MIGRATIONS_DIR);
    } catch {
      process.stderr.write(`[e2e setup] migrations dir not found: ${MIGRATIONS_DIR}\n`);
      return;
    }

    const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort();

    for (const file of sqlFiles) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        process.stdout.write(`[e2e setup] applied migration: ${file}\n`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

// ── vitest globalSetup lifecycle ──────────────────────────────────────────────

export async function setup() {
  const ok = await checkPostgres();
  if (!ok) {
    process.stdout.write("[e2e setup] Postgres not available — all e2e tests will be skipped\n");
    process.env["SKIP_E2E"] = "true";
    return;
  }

  process.stdout.write("[e2e setup] Postgres available — preparing camellia_e2e DB\n");

  await createE2eDb();
  await runMigrations();

  process.env["DATABASE_URL"] = E2E_DATABASE_URL;
  process.env["SKIP_E2E"] = "false";
  process.stdout.write("[e2e setup] DB ready\n");
}

export async function teardown() {
  if (process.env["SKIP_E2E"] === "true") return;

  const pool = new pg.Pool({ connectionString: E2E_DATABASE_URL });
  try {
    // truncate in reverse FK order
    await pool.query(`
      TRUNCATE TABLE
        ai_usage,
        deployment_steps,
        approvals,
        env_locks,
        ir_versions,
        analysis_reports,
        source_versions,
        deployments,
        projects
      RESTART IDENTITY CASCADE
    `);
    process.stdout.write("[e2e teardown] tables truncated\n");
  } catch (err) {
    process.stderr.write(`[e2e teardown] truncate failed: ${String(err)}\n`);
  } finally {
    await pool.end().catch(() => {});
  }
}
