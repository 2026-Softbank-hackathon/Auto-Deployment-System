/**
 * packages/analyzer/src/detectors/database.ts
 *
 * 데이터베이스 리소스 감지기.
 *
 * 감지 규칙:
 *   - SQLite 사용(npm better-sqlite3 · sqlite3 · sqlite, 코드의 node:sqlite · python sqlite3, Prisma sqlite)
 *     → { name:"db", type:"postgres", connection_env:"DATABASE_URL", local_fallback:"sqlite" } + warning
 *   - *.db / *.sqlite 파일만 있고 코드에서 안 쓰면 → warning 만
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
  // 1. SQLite 사용 감지 (#276) — 의존성 · 코드 · Prisma 스키마
  //    쓰고 있으면 PostgreSQL 로 옮길 리소스를 제안한다. 접속 정보는 DATABASE_URL 로 주입하고,
  //    수정된 앱은 DATABASE_URL 이 없으면 SQLite 로 동작한다(local_fallback, 온프레미스).
  //    데이터 파일만 있고 코드에서 쓰지 않으면 경고만 남긴다.
  // ------------------------------------------------------------------
  const sqliteFiles = (
    await fg(["**/*.db", "**/*.sqlite", "**/*.sqlite3"], {
      cwd: serviceDir,
      absolute: false,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
      deep: 4,
    })
  ).sort();
  const sqliteUsage = await detectSqliteUsage(serviceDir, nodeDeps);

  if (sqliteUsage) {
    warnings.push({
      code: "ANL-06-SQLITE",
      message:
        `SQLite 사용 감지 (${sqliteUsage.libraries.join(", ")}). ` +
        "AWS 는 PostgreSQL(RDS)로 옮기는 코드 수정안을 만들고, 온프레미스는 SQLite 그대로 실행합니다.",
      path: sqliteUsage.sources[0] ?? sqliteFiles[0],
    });
    resources.push({
      name: "db",
      type: "postgres",
      connection_env: SQLITE_CONNECTION_ENV,
      local_fallback: "sqlite",
      detected_from: [
        ...sqliteUsage.evidence,
        ...sqliteFiles.map((file) => `${file} (SQLite data file)`),
      ],
      sqlite: {
        libraries: sqliteUsage.libraries,
        sources: sqliteUsage.sources,
        files: sqliteFiles,
      },
    });
    seenTypes.add("postgres");
  } else if (sqliteFiles.length > 0) {
    warnings.push({
      code: "ANL-06-SQLITE-FILE",
      message:
        `SQLite 파일 감지 (${sqliteFiles[0]}). 코드에서 SQLite 를 쓰는 곳을 찾지 못해 DB 전환 없이 배포합니다.`,
      path: sqliteFiles[0],
    });
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

/** SQLite 에서 옮긴 PostgreSQL 의 접속 정보를 받는 환경변수 */
export const SQLITE_CONNECTION_ENV = "DATABASE_URL";

/** npm 패키지 이름 → 코드에서 찾을 모듈 이름 */
const NODE_SQLITE_DEPS = ["better-sqlite3", "sqlite3", "sqlite"];

/** 소스 한 줄에서 SQLite 사용을 알아보는 규칙 (라이브러리 이름, 정규식) */
const SQLITE_CODE_PATTERNS: Array<{ library: string; pattern: RegExp }> = [
  { library: "node:sqlite", pattern: /["']node:sqlite["']/ },
  { library: "better-sqlite3", pattern: /["']better-sqlite3["']/ },
  { library: "sqlite3", pattern: /(?:from|require\()\s*["']sqlite3["']/ },
  { library: "sqlite", pattern: /(?:from|require\()\s*["']sqlite["']/ },
  { library: "sqlite3 (python)", pattern: /^\s*(?:import\s+sqlite3\b|from\s+sqlite3\s+import\b)/m },
  { library: "sqlite (url)", pattern: /["']sqlite:\/\/\// },
  { library: "django sqlite3", pattern: /django\.db\.backends\.sqlite3/ },
];

type SqliteUsage = {
  libraries: string[];
  sources: string[];
  evidence: string[];
};

/**
 * 의존성 · 소스 · Prisma 스키마에서 SQLite 사용을 찾는다. 못 찾으면 null.
 * sources 는 SQLite 를 직접 쓰는 파일 — 수정안 생성(#277)이 이 파일들을 고친다.
 */
async function detectSqliteUsage(
  serviceDir: string,
  nodeDeps: Record<string, string>,
): Promise<SqliteUsage | null> {
  const libraries = new Set<string>();
  const evidence: string[] = [];
  const depNames = Object.keys(nodeDeps).map((name) => name.toLowerCase());
  for (const dep of NODE_SQLITE_DEPS) {
    if (depNames.includes(dep)) {
      libraries.add(dep);
      evidence.push(`package.json dependencies.${dep}`);
    }
  }

  const sourceFiles = (
    await fg(["**/*.{js,cjs,mjs,ts,cts,mts,jsx,tsx,py}"], {
      cwd: serviceDir,
      onlyFiles: true,
      ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/*.d.ts"],
      deep: 5,
    })
  ).sort();
  const sources: string[] = [];
  for (const file of sourceFiles) {
    let content: string;
    try {
      content = await readFile(join(serviceDir, file), "utf8");
    } catch {
      continue;
    }
    const matched = SQLITE_CODE_PATTERNS.filter(({ pattern }) => pattern.test(content));
    if (matched.length === 0) continue;
    sources.push(file);
    for (const { library } of matched) libraries.add(library);
    evidence.push(`${file} (${matched.map((m) => m.library).join(", ")})`);
  }

  const prismaSchemas = await fg(["**/schema.prisma"], {
    cwd: serviceDir,
    onlyFiles: true,
    ignore: ["**/node_modules/**"],
    deep: 4,
  });
  for (const schema of prismaSchemas.sort()) {
    const content = await readFile(join(serviceDir, schema), "utf8").catch(() => "");
    if (/provider\s*=\s*["']sqlite["']/.test(content)) {
      libraries.add("prisma (sqlite)");
      sources.push(schema);
      evidence.push(`${schema} (provider = "sqlite")`);
    }
  }

  if (libraries.size === 0) return null;
  return { libraries: [...libraries], sources, evidence };
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
