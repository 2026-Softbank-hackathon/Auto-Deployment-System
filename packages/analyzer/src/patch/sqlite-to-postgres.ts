/**
 * packages/analyzer/src/patch/sqlite-to-postgres.ts
 *
 * PAT-02 · MIG-03 (#277): SQLite 를 쓰는 앱 코드를 PostgreSQL 도 쓰도록 고친 수정안을 만든다.
 *
 * 수정된 코드는 두 모드로 동작한다 (dual-mode):
 *   - 접속 환경변수(DATABASE_URL)가 있으면 PostgreSQL. 처음 뜰 때 테이블이 비어 있으면
 *     소스에 들어 있던 SQLite 파일의 행을 옮겨 온다(데이터 이전 MIG-03 — 앱 태스크가 RDS 와 같은 VPC 에 있어서).
 *   - 없으면 지금처럼 SQLite.
 * 그래서 한 번 빌드한 같은 이미지가 AWS(RDS)와 온프레미스(SQLite, DB 없음)에서 모두 돈다.
 *
 * 코드 변환은 Claude(구조화 출력)가 하고, 규칙으로 할 수 있는 일은 규칙으로 한다:
 *   보낼 파일 고르기 · 시크릿 가리기(D-50) · 결과 검증(경로 · 접속 환경변수 · SQLite 경로 유지) ·
 *   의존성(pg · @types/pg · psycopg) · package-lock.json 갱신 · unified diff.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import fg from "fast-glob";

import type { ResourceCandidate } from "../types.js";
import { usesSqlite } from "../detectors/database.js";
import { createClient, resolveAiProvider, resolveModel } from "../ai/anthropic-client.js";
import type { AnthropicLike } from "../ai/anthropic-client.js";
import { redact } from "../ai/redact.js";
import { buildTokenUsage } from "../ai/tokens.js";
import type { TokenUsage } from "../ai/tokens.js";
import {
  addNodePostgresDependencies,
  addPythonPostgresRequirement,
  PG_VERSION,
  PSYCOPG_REQUIREMENT,
  TYPES_PG_VERSION,
} from "./dependencies.js";
import { createUnifiedDiff } from "./unified-diff.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PatchFile = {
  /** 앱(서비스) 폴더 기준 상대 경로, "/" 구분 */
  path: string;
  /** 원래 내용. 새 파일이면 null */
  before: string | null;
  after: string;
  /** 규칙으로 다시 만든 파일(package-lock.json) — diff 대신 "자동 갱신" 으로만 보여 준다 */
  generated?: boolean;
};

export type SqlitePatch = {
  status: "ready";
  /** 사용자에게 보여 줄 한두 문장 요약 (한국어) */
  summary: string;
  notes: string[];
  files: PatchFile[];
  /** generated 파일을 뺀 unified diff */
  diff: string;
  generator: "ai";
  model: string;
};

export type SqlitePatchSkipped = {
  status: "skipped";
  /** 코드 (예: AI_DISABLED · SOURCE_TOO_LARGE · AI_INVALID_PATCH) + 설명 */
  reason: string;
};

export type SqlitePatchOptions = {
  /** 테스트용 Claude 클라이언트 */
  client?: AnthropicLike;
  model?: string;
  /** AI 호출마다 사용량 기록 (CST-01) */
  onUsage?: (usage: TokenUsage) => void | Promise<void>;
  /** package-lock.json 을 다시 만든다. 기본: npm install --package-lock-only */
  updateLockfile?: (directory: string) => Promise<void>;
  /** 검증에 실패하면 이유를 알려 주고 다시 묻는 횟수 포함 최대 시도. 기본 2 */
  maxAttempts?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODE_GLOB = "**/*.{js,cjs,mjs,ts,cts,mts,jsx,tsx,py}";
const CODE_EXTENSION = /\.(?:js|cjs|mjs|ts|cts|mts|jsx|tsx|py)$/;
const IGNORED = ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.git/**", "**/*.d.ts", "**/*.min.js"];
/** AI 에 보내는 코드 총량 상한 — 작은 웹앱 기준. 넘으면 SQLite 를 쓰는 파일만 보낸다 */
const SOURCE_BUDGET_BYTES = 150_000;
const CONTEXT_FILES = ["package.json", "tsconfig.json", "Dockerfile", "requirements.txt", ".env.example"];
const CONTEXT_FILE_LIMIT = 16_000;
/**
 * Opus 5.5 는 thinking 을 끌 수 없고 thinking 도 max_tokens 에 들어간다. 파일 전체 내용을 돌려받으므로 넉넉히,
 * 그러나 스트리밍 없이 보낼 수 있는 상한(약 21K) 안에서.
 */
const MAX_TOKENS = 20_000;
/** 코드 변환은 빈칸 채우기보다 어렵다 → medium (결과는 아래에서 다시 검증한다) */
const EFFORT = "medium" as const;
const REDACTED_MARK = "[REDACTED]";

export const SQLITE_PATCH_SYSTEM_PROMPT = `You convert a small web app that stores its data in SQLite so that the SAME build also runs on PostgreSQL.
The platform deploys one container image to two places: AWS, where it creates a PostgreSQL database and sets the connection environment variable, and an on-premises server, where no database exists and the variable is NOT set.

Rewrite the app's data-access code in "dual mode":
1. Read the connection string from the environment variable named in "connection_env". If it is set and non-empty, use PostgreSQL. Otherwise keep the existing SQLite behaviour exactly as it is today (same file path, same library, same results). In PostgreSQL mode do not open or create the SQLite database except read-only for the one-time import below.
2. Node.js: use the "pg" package with \`new Pool({ connectionString })\` (ESM: \`import pg from "pg"\` then \`new pg.Pool(...)\`). The URL has no password; pg reads it from the PGPASSWORD environment variable automatically. Do not configure SSL. Python: use psycopg 3 (\`import psycopg\`).
3. PostgreSQL access is asynchronous. Make the data-access functions async (return Promises in both modes) and update every caller (route handlers, page rendering, health checks) to await them. Keep function names, exported signatures (apart from becoming async) and HTTP routes/response shapes unchanged.
4. Translate SQL for PostgreSQL: "?" placeholders become $1, $2, ...; INTEGER PRIMARY KEY AUTOINCREMENT becomes SERIAL PRIMARY KEY; SQLite date functions become PostgreSQL expressions that produce the same text format (for strftime('%Y-%m-%dT%H:%M:%SZ','now') use to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')); INSERT OR IGNORE becomes ON CONFLICT DO NOTHING; keep RETURNING. COUNT(*) and BIGINT come back from pg as strings: convert them with Number(). Keep column names and value formats the app expects.
5. Create the PostgreSQL schema at startup with CREATE TABLE IF NOT EXISTS before the app serves requests.
6. One-time data import: at startup in PostgreSQL mode, in a single transaction that first takes pg_advisory_xact_lock with a fixed constant, for every table: if the PostgreSQL table has no rows and one of the SQLite data files listed in "sqlite_data_files" exists at the path the SQLite mode uses, open it read-only with the SQLite library the app already uses, copy all rows with explicit column lists (keep ids), then reset the id sequence with SELECT setval(pg_get_serial_sequence('<table>', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM <table>. Never import into a table that already has rows. Log how many rows were imported.
7. The app must not answer requests (including its health check) as healthy before PostgreSQL schema creation and import have finished; start listening only after initialisation succeeds (e.g. init().then(startServer)), and exit with an error if it fails. Do not use top-level await: the build may bundle the app to CommonJS. If a health endpoint exists, make it run SELECT 1 against the active database and return HTTP 503 when that fails.
8. If the app displays which storage it uses, make it report "PostgreSQL" in PostgreSQL mode.
9. Change as little as possible. Do not modify package.json, lock files, Dockerfile, build scripts, ports or routes; the platform adds the dependencies listed in "platform_dependencies". Do not add any other dependency. TypeScript must still compile in strict mode: type query results explicitly (e.g. pool.query<Row>(...)).
10. Only edit files listed in "files" or create new source files. Return each changed or new file with its COMPLETE new content and its path exactly as given (relative to the app root). Do not return unchanged files.

Write "summary" in Korean: one or two plain sentences for the person approving the change (what changes and what happens on AWS and on-premises). "notes": short Korean notes about anything they should know; may be empty.`;

export const SQLITE_PATCH_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "1-2 Korean sentences describing the change for the approver." },
    notes: { type: "array", items: { type: "string" }, description: "Short Korean notes; may be empty." },
    files: {
      type: "array",
      description: "Changed or new files with their complete new content.",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the app root, exactly as given." },
          content: { type: "string", description: "Complete new file content." },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "notes", "files"],
  additionalProperties: false,
} as const;

type AiPatchResponse = {
  summary: string;
  notes: string[];
  files: Array<{ path: string; content: string }>;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * serviceDir(앱 폴더)의 SQLite 사용 코드를 dual-mode 로 고친 수정안을 만든다. 파일은 바꾸지 않는다 — applyPatch 로 적용.
 */
export async function createSqlitePatch(
  serviceDir: string,
  resource: ResourceCandidate,
  opts: SqlitePatchOptions = {},
): Promise<SqlitePatch | SqlitePatchSkipped> {
  const connectionEnv = resource.connection_env ?? "DATABASE_URL";
  const sqliteSources = resource.sqlite?.sources ?? [];
  if (sqliteSources.length === 0) {
    return skipped("NO_SQLITE_SOURCE", "SQLite 를 쓰는 소스 파일을 찾지 못했습니다");
  }
  if (sqliteSources.some((source) => source.endsWith(".prisma"))) {
    return skipped("PRISMA_UNSUPPORTED", "Prisma 스키마 전환은 아직 자동으로 하지 않습니다");
  }

  const editable = await collectSourceFiles(serviceDir, sqliteSources);
  if (editable === null) {
    return skipped("SOURCE_TOO_LARGE", "SQLite 를 쓰는 코드가 너무 커서 자동 수정안을 만들지 않았습니다");
  }
  const context = await collectContextFiles(serviceDir);
  const isNode = context.has("package.json");
  const isTypeScript =
    context.has("tsconfig.json") || [...editable.keys()].some((path) => /\.(?:ts|cts|mts|tsx)$/.test(path));
  const isPython = !isNode && [...editable.keys()].some((path) => path.endsWith(".py"));

  // 클라이언트: 주입 > env (AI_PROVIDER · ANTHROPIC_API_KEY)
  let client = opts.client;
  let provider = resolveAiProvider().provider;
  if (!client) {
    if (provider === null) return skipped("AI_DISABLED", "AI 가 꺼져 있어 수정안을 만들 수 없습니다");
    try {
      client = await createClient({ provider });
    } catch (error) {
      return skipped("AI_CLIENT_FAILED", String(error));
    }
  }
  provider ??= "anthropic";
  const model = opts.model ?? resolveModel("patch", provider);

  const platformDependencies = isNode
    ? [`pg ${PG_VERSION}`, ...(isTypeScript ? [`@types/pg ${TYPES_PG_VERSION} (dev)`] : [])]
    : isPython
      ? [PSYCOPG_REQUIREMENT]
      : [];
  const payload = {
    connection_env: connectionEnv,
    language: isNode ? (isTypeScript ? "node-typescript" : "node-javascript") : isPython ? "python" : "unknown",
    sqlite_libraries: resource.sqlite?.libraries ?? [],
    sqlite_data_files: resource.sqlite?.files ?? [],
    files_using_sqlite: sqliteSources,
    platform_dependencies: platformDependencies,
    files: [...editable].map(([path, content]) => ({ path, content: redact(content) })),
    context_files: [...context].map(([path, content]) => ({ path, content: redact(content) })),
  };

  const maxAttempts = opts.maxAttempts ?? 2;
  let feedback: string[] = [];
  let lastProblem = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const userContent =
      JSON.stringify(payload) +
      (feedback.length > 0
        ? `\n\nYour previous answer was rejected for these reasons. Fix them and answer again:\n- ${feedback.join("\n- ")}`
        : "");
    let parsed: unknown;
    try {
      const response = await client.messages.create({
        model,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: SQLITE_PATCH_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        output_config: {
          effort: EFFORT,
          format: { type: "json_schema", schema: SQLITE_PATCH_SCHEMA as unknown as Record<string, unknown> },
        },
        messages: [{ role: "user", content: userContent }],
      });
      const usage = response.usage as Record<string, unknown>;
      await opts.onUsage?.(
        buildTokenUsage(model, {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_creation_input_tokens: usage["cache_creation_input_tokens"] as number | undefined,
          cache_read_input_tokens: usage["cache_read_input_tokens"] as number | undefined,
        }),
      );
      if (response.stop_reason === "refusal") return skipped("AI_REFUSED", "모델이 수정안 생성을 거절했습니다");
      if (response.stop_reason === "max_tokens") {
        return skipped("AI_OUTPUT_TOO_LONG", `응답이 max_tokens(${MAX_TOKENS}) 에서 잘렸습니다`);
      }
      const text = response.content.find(
        (block): block is Extract<typeof block, { type: "text" }> => block.type === "text",
      );
      parsed = text ? JSON.parse(text.text) : undefined;
    } catch (error) {
      lastProblem = `AI 호출 실패: ${error instanceof Error ? error.message : String(error)}`;
      continue;
    }

    if (!isAiPatchResponse(parsed)) {
      feedback = ["The answer did not match the JSON schema."];
      lastProblem = "응답 형식이 맞지 않습니다";
      continue;
    }
    const checked = await validateAiFiles(serviceDir, editable, parsed.files, connectionEnv);
    if (checked.errors.length > 0) {
      feedback = checked.errors;
      lastProblem = checked.errors.join(" / ");
      continue;
    }

    const files = [...checked.files];
    const notes = parsed.notes.filter((note) => note.trim() !== "");
    try {
      const dependencyFiles = await updateDependencies(serviceDir, context, {
        isNode,
        isPython,
        isTypeScript,
        updateLockfile: opts.updateLockfile ?? npmLockfileUpdate,
      });
      files.push(...dependencyFiles.files);
      notes.push(...dependencyFiles.notes);
    } catch (error) {
      return skipped(
        "DEPENDENCY_UPDATE_FAILED",
        `의존성 파일을 갱신하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      status: "ready",
      summary: parsed.summary.trim(),
      notes,
      files,
      diff: files
        .filter((file) => !file.generated)
        .map((file) => createUnifiedDiff(file.path, file.before, file.after))
        .join(""),
      generator: "ai",
      model,
    };
  }
  return skipped("AI_INVALID_PATCH", lastProblem || "검증을 통과한 수정안을 받지 못했습니다");
}

/** 수정안 파일을 앱 폴더에 쓴다 */
export async function applyPatch(serviceDir: string, files: PatchFile[]): Promise<void> {
  for (const file of files) {
    const target = join(serviceDir, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.after);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skipped(code: string, message: string): SqlitePatchSkipped {
  return { status: "skipped", reason: `${code}: ${message}` };
}

function isAiPatchResponse(value: unknown): value is AiPatchResponse {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["summary"] === "string" &&
    Array.isArray(record["notes"]) &&
    record["notes"].every((note) => typeof note === "string") &&
    Array.isArray(record["files"]) &&
    record["files"].every(
      (file) =>
        typeof file === "object" &&
        file !== null &&
        typeof (file as Record<string, unknown>)["path"] === "string" &&
        typeof (file as Record<string, unknown>)["content"] === "string",
    )
  );
}

/** 고칠 수 있는 코드 파일. SQLite 를 쓰는 파일이 먼저, 나머지는 예산 안에서. SQLite 파일만으로 넘치면 null */
async function collectSourceFiles(serviceDir: string, sqliteSources: string[]): Promise<Map<string, string> | null> {
  const all = (await fg([CODE_GLOB], { cwd: serviceDir, onlyFiles: true, ignore: IGNORED, deep: 6 })).sort();
  const ordered = [...sqliteSources.filter((path) => all.includes(path)), ...all.filter((path) => !sqliteSources.includes(path))];
  const files = new Map<string, string>();
  let total = 0;
  for (const path of ordered) {
    const content = await readFile(join(serviceDir, path), "utf8");
    const required = sqliteSources.includes(path);
    if (total + content.length > SOURCE_BUDGET_BYTES) {
      if (required) return null;
      continue;
    }
    files.set(path, content);
    total += content.length;
  }
  return files;
}

async function collectContextFiles(serviceDir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const name of CONTEXT_FILES) {
    const content = await readFile(join(serviceDir, name), "utf8").catch(() => null);
    if (content !== null) files.set(name, content.slice(0, CONTEXT_FILE_LIMIT));
  }
  return files;
}

function normalizePath(raw: string): string | null {
  if (raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return null;
  const normalized = posix.normalize(raw).replace(/^\.\//, "");
  if (normalized === "" || normalized === "." || normalized.startsWith("../") || normalized === "..") return null;
  if (/(^|\/)(node_modules|dist|\.git)(\/|$)/.test(normalized)) return null;
  return normalized;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** AI 가 돌려준 파일을 검증해 PatchFile 로 바꾼다. 문제가 있으면 errors 에 모델에게 다시 알려 줄 문장을 남긴다 */
async function validateAiFiles(
  serviceDir: string,
  originals: Map<string, string>,
  files: AiPatchResponse["files"],
  connectionEnv: string,
): Promise<{ files: PatchFile[]; errors: string[] }> {
  const errors: string[] = [];
  const result: PatchFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const path = normalizePath(file.path);
    if (path === null) {
      errors.push(`"${file.path}" is not a valid relative path inside the app.`);
      continue;
    }
    if (seen.has(path)) {
      errors.push(`"${path}" appears more than once.`);
      continue;
    }
    seen.add(path);
    if (!CODE_EXTENSION.test(path)) {
      errors.push(`"${path}" must not be edited; only source files can be changed.`);
      continue;
    }
    const before = originals.get(path);
    if (before === undefined && (await exists(join(serviceDir, ...path.split("/"))))) {
      errors.push(`"${path}" exists but was not provided; only edit files listed in "files".`);
      continue;
    }
    if (file.content.includes(REDACTED_MARK)) {
      errors.push(`"${path}" contains a ${REDACTED_MARK} placeholder; keep the original code around redacted values unchanged.`);
      continue;
    }
    if (file.content.trim() === "") {
      errors.push(`"${path}" is empty.`);
      continue;
    }
    if (before === file.content) continue;
    result.push({ path, before: before ?? null, after: file.content });
  }
  if (errors.length > 0) return { files: [], errors };
  if (result.length === 0) return { files: [], errors: ["No file was changed."] };

  const changed = new Map(result.map((file) => [file.path, file.after]));
  const merged = [...originals].map(([path, content]) => changed.get(path) ?? content);
  merged.push(...result.filter((file) => file.before === null).map((file) => file.after));
  if (!result.some((file) => file.after.includes(connectionEnv))) {
    errors.push(`The changed code never reads the ${connectionEnv} environment variable.`);
  }
  if (!merged.some(usesSqlite)) {
    errors.push("The SQLite code path was removed; it must stay as the fallback when the variable is not set.");
  }
  return errors.length > 0 ? { files: [], errors } : { files: result, errors };
}

async function updateDependencies(
  serviceDir: string,
  context: Map<string, string>,
  options: {
    isNode: boolean;
    isPython: boolean;
    isTypeScript: boolean;
    updateLockfile: (directory: string) => Promise<void>;
  },
): Promise<{ files: PatchFile[]; notes: string[] }> {
  const files: PatchFile[] = [];
  const notes: string[] = [];
  if (options.isNode) {
    const before = await readFile(join(serviceDir, "package.json"), "utf8");
    const updated = addNodePostgresDependencies(before, { typescript: options.isTypeScript });
    if (updated.changed) {
      files.push({ path: "package.json", before, after: updated.text });
      notes.push(...updated.notes);
      const lockBefore = await readFile(join(serviceDir, "package-lock.json"), "utf8").catch(() => null);
      if (lockBefore !== null) {
        const lockAfter = await regenerateLockfile(updated.text, lockBefore, options.updateLockfile);
        files.push({ path: "package-lock.json", before: lockBefore, after: lockAfter, generated: true });
      } else if (await exists(join(serviceDir, "pnpm-lock.yaml")) || await exists(join(serviceDir, "yarn.lock"))) {
        notes.push("pnpm · yarn lock 파일은 자동으로 갱신하지 않습니다. 빌드가 frozen lockfile 이면 실패할 수 있습니다.");
      }
    }
  } else if (options.isPython && context.has("requirements.txt")) {
    const before = await readFile(join(serviceDir, "requirements.txt"), "utf8");
    const updated = addPythonPostgresRequirement(before);
    if (updated.changed) files.push({ path: "requirements.txt", before, after: updated.text });
  }
  return { files, notes };
}

async function regenerateLockfile(
  packageJson: string,
  lockfile: string,
  update: (directory: string) => Promise<void>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "camellia-lockfile-"));
  try {
    await writeFile(join(directory, "package.json"), packageJson);
    await writeFile(join(directory, "package-lock.json"), lockfile);
    await update(directory);
    return await readFile(join(directory, "package-lock.json"), "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const execFileAsync = promisify(execFile);

/** 기본 lock 파일 갱신 — 패키지 설치 · 스크립트 실행 없이 lock 파일만 다시 계산한다 */
async function npmLockfileUpdate(directory: string): Promise<void> {
  await execFileAsync(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: directory, timeout: 120_000, shell: process.platform === "win32" },
  );
}
