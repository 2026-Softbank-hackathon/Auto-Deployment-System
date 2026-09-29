/**
 * packages/analyzer/src/detectors/database.ts
 *
 * 데이터베이스 리소스 감지기.
 *
 * 감지 규칙:
 *   - *.db / *.sqlite 파일 → resources에 { name:"db", type:"postgres" } + warning (SQLite 감지)
 *   - npm dep: pg / pg-promise / @neondatabase/serverless → postgres
 *   - npm dep: mysql / mysql2 → mysql
 *   - npm dep: redis / ioredis → redis
 *   - py dep: psycopg2 / psycopg / asyncpg → postgres
 *   - py dep: PyMySQL / mysqlclient → mysql
 *   - py dep: redis / aioredis → redis
 *   - DATABASE_URL 환경변수 참조 감지 → postgres (URL scheme 기준)
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";
import type { ResourceCandidate, Warning } from "../types.js";

export type DatabaseDetectResult = {
  resources: ResourceCandidate[];
  warnings: Warning[];
};

const NODE_POSTGRES_DEPS = ["pg", "pg-promise", "@neondatabase/serverless", "postgres", "knex"];
const NODE_MYSQL_DEPS = ["mysql", "mysql2", "sequelize"];
const NODE_REDIS_DEPS = ["redis", "ioredis", "@upstash/redis"];

const PY_POSTGRES_PKGS = ["psycopg2", "psycopg2-binary", "psycopg", "asyncpg"];
const PY_MYSQL_PKGS = ["pymysql", "mysqlclient", "aiomysql"];
const PY_REDIS_PKGS = ["redis", "aioredis", "redis-py"];

export async function detectDatabase(
  serviceDir: string,
  nodeDeps: Record<string, string>,
  pyPackages: string[]
): Promise<DatabaseDetectResult> {
  const resources: ResourceCandidate[] = [];
  const warnings: Warning[] = [];
  const seenTypes = new Set<string>();

  // ------------------------------------------------------------------
  // 1. SQLite file detection
  // ------------------------------------------------------------------
  const sqliteFiles = await fg(["**/*.db", "**/*.sqlite", "**/*.sqlite3"], {
    cwd: serviceDir,
    absolute: false,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
    deep: 4,
  });

  if (sqliteFiles.length > 0) {
    warnings.push({
      code: "ANL-06-SQLITE",
      message:
        `SQLite 파일 감지 (${sqliteFiles[0]}). ` +
        "P1 단계에서 Postgres로 전환 예정. 데이터 마이그레이션 계획 수립 필요.",
      path: sqliteFiles[0],
    });
    if (!seenTypes.has("postgres")) {
      resources.push({
        name: "db",
        type: "postgres",
        detected_from: [`${sqliteFiles[0]} (SQLite → Postgres candidate)`],
      });
      seenTypes.add("postgres");
    }
  }

  // ------------------------------------------------------------------
  // 2. Node.js dependency-based detection
  // ------------------------------------------------------------------
  if (Object.keys(nodeDeps).length > 0) {
    const depsLower = Object.keys(nodeDeps).map((k) => k.toLowerCase());

    if (!seenTypes.has("postgres") && NODE_POSTGRES_DEPS.some((d) => depsLower.includes(d))) {
      const matched = NODE_POSTGRES_DEPS.filter((d) => depsLower.includes(d));
      resources.push({
        name: "db",
        type: "postgres",
        detected_from: matched.map((d) => `package.json dependencies.${d}`),
      });
      seenTypes.add("postgres");
    }

    if (!seenTypes.has("mysql") && NODE_MYSQL_DEPS.some((d) => depsLower.includes(d))) {
      const matched = NODE_MYSQL_DEPS.filter((d) => depsLower.includes(d));
      resources.push({
        name: "db",
        type: "mysql",
        detected_from: matched.map((d) => `package.json dependencies.${d}`),
      });
      seenTypes.add("mysql");
    }

    if (!seenTypes.has("redis") && NODE_REDIS_DEPS.some((d) => depsLower.includes(d))) {
      const matched = NODE_REDIS_DEPS.filter((d) => depsLower.includes(d));
      resources.push({
        name: "cache",
        type: "redis",
        detected_from: matched.map((d) => `package.json dependencies.${d}`),
      });
      seenTypes.add("redis");
    }
  }

  // ------------------------------------------------------------------
  // 3. Python dependency-based detection
  // ------------------------------------------------------------------
  if (pyPackages.length > 0) {
    const pyLower = pyPackages.map((p) => p.toLowerCase());

    if (!seenTypes.has("postgres") && PY_POSTGRES_PKGS.some((d) => pyLower.some((p) => p.startsWith(d)))) {
      const matched = PY_POSTGRES_PKGS.filter((d) => pyLower.some((p) => p.startsWith(d)));
      resources.push({
        name: "db",
        type: "postgres",
        detected_from: matched.map((d) => `requirements (${d})`),
      });
      seenTypes.add("postgres");
    }

    if (!seenTypes.has("mysql") && PY_MYSQL_PKGS.some((d) => pyLower.some((p) => p.startsWith(d)))) {
      const matched = PY_MYSQL_PKGS.filter((d) => pyLower.some((p) => p.startsWith(d)));
      resources.push({
        name: "db",
        type: "mysql",
        detected_from: matched.map((d) => `requirements (${d})`),
      });
      seenTypes.add("mysql");
    }

    if (!seenTypes.has("redis") && PY_REDIS_PKGS.some((d) => pyLower.some((p) => p.startsWith(d)))) {
      const matched = PY_REDIS_PKGS.filter((d) => pyLower.some((p) => p.startsWith(d)));
      resources.push({
        name: "cache",
        type: "redis",
        detected_from: matched.map((d) => `requirements (${d})`),
      });
      seenTypes.add("redis");
    }
  }

  // ------------------------------------------------------------------
  // 4. DATABASE_URL env reference scan (code files)
  // ------------------------------------------------------------------
  if (!seenTypes.has("postgres")) {
    const dbUrlType = await scanDatabaseUrlScheme(serviceDir);
    if (dbUrlType) {
      resources.push({
        name: "db",
        type: dbUrlType,
        detected_from: ["DATABASE_URL env reference in source"],
      });
      seenTypes.add(dbUrlType);
    }
  }

  return { resources, warnings };
}

async function scanDatabaseUrlScheme(
  serviceDir: string
): Promise<"postgres" | "mysql" | "redis" | null> {
  const sourceFiles = await fg(
    ["**/*.js", "**/*.ts", "**/*.py", "**/*.mjs"],
    {
      cwd: serviceDir,
      absolute: true,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/dist/**"],
      deep: 4,
    }
  );

  // Also check .env files
  const envFiles = await fg([".env", ".env.*"], {
    cwd: serviceDir,
    absolute: true,
    onlyFiles: true,
    deep: 1,
  });

  const allFiles = [...sourceFiles, ...envFiles];

  for (const file of allFiles) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }

    if (/DATABASE_URL\s*=\s*postgres(ql)?:\/\//.test(content)) return "postgres";
    if (/DATABASE_URL\s*=\s*mysql:\/\//.test(content)) return "mysql";
    if (/DATABASE_URL\s*=\s*redis:\/\//.test(content)) return "redis";
    // Check reference without value (just usage)
    if (/DATABASE_URL/.test(content)) return "postgres"; // default assumption
  }

  return null;
}
