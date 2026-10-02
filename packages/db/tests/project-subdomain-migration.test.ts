import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "../src/index.js";

const migrationsDir = new URL("../migrations/", import.meta.url);
const migrationFile = "022_project_subdomain.sql";

describe("022_project_subdomain migration (#300)", () => {
  it("subdomain 컬럼은 NULL 허용, 대소문자 무시 유일, 기존 앱은 service-{id} 로 채운다", async () => {
    const sql = await readFile(new URL(migrationFile, migrationsDir), "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS subdomain TEXT;/i);
    expect(sql).toMatch(/UPDATE projects SET subdomain = 'service-' \|\| id WHERE subdomain IS NULL/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS projects_subdomain_unique\s+ON projects \(lower\(subdomain\)\)/i);
    // 기존 row 를 지우지 않는다
    expect(sql.replace(/--.*$/gm, "")).not.toMatch(/\b(DELETE FROM|DROP TABLE|DROP COLUMN|TRUNCATE)\b/i);
  });
});

// 예: PROJECT_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5436/postgres
const databaseUrl = process.env["PROJECT_TEST_DATABASE_URL"];
const schema = `project_subdomain_${randomUUID().replaceAll("-", "")}`;
let admin: Pool;
let pool: Pool;

describe.skipIf(!databaseUrl)("022_project_subdomain: 실제 PostgreSQL", () => {
  let existingId: number;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files.filter((f) => f < migrationFile)) {
      await pool.query(await readFile(new URL(file, migrationsDir), "utf8"));
    }
    const existing = await pool.query<{ id: string }>(`INSERT INTO projects (name) VALUES ('before') RETURNING id`);
    existingId = Number(existing.rows[0]!.id);
    await pool.query(await readFile(new URL(migrationFile, migrationsDir), "utf8"));
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("마이그레이션 전에 있던 앱은 지금 주소(service-{id})를 그대로 쓴다", async () => {
    const row = await pool.query(`SELECT subdomain FROM projects WHERE id = $1`, [existingId]);
    expect(row.rows[0].subdomain).toBe(`service-${existingId}`);
  });

  it("주소 없이 만든 앱은 service-{id}, 고른 앱은 그 주소", async () => {
    const plain = await pool.query(`INSERT INTO projects (name) VALUES ('plain') RETURNING id, subdomain`);
    expect(plain.rows[0].subdomain).toBe(`service-${plain.rows[0].id}`);
    const chosen = await pool.query(
      `INSERT INTO projects (name, subdomain) VALUES ('chosen', 'shop') RETURNING subdomain`,
    );
    expect(chosen.rows[0].subdomain).toBe("shop");
  });

  it("같은 주소(대소문자 무시)는 두 앱이 쓸 수 없다", async () => {
    await expect(
      pool.query(`INSERT INTO projects (name, subdomain) VALUES ('dup', 'SHOP')`),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("다시 실행해도 된다", async () => {
    await pool.query(await readFile(new URL(migrationFile, migrationsDir), "utf8"));
  });
});
