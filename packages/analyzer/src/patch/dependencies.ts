/**
 * packages/analyzer/src/patch/dependencies.ts
 *
 * 수정안의 의존성 변경은 AI 에 맡기지 않고 규칙으로 한다 (#277).
 *   - Node: dependencies.pg 추가, TypeScript 앱이면 devDependencies["@types/pg"] 추가
 *   - esbuild 로 ESM 번들을 만드는 스크립트는 CommonJS 패키지(pg)가 node 내장 모듈을 require 할 수 있게 createRequire 배너를 붙인다
 *   - Python: requirements.txt 에 psycopg[binary] 추가
 */

export const PG_VERSION = "^8.23.1";
export const TYPES_PG_VERSION = "^8.23.1";
export const PSYCOPG_REQUIREMENT = "psycopg[binary]>=3.2";

const ESM_REQUIRE_BANNER =
  `--banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"`;

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
};

/**
 * package.json 에 PostgreSQL 클라이언트를 더한다. 바뀐 게 없으면 changed=false.
 * 들여쓰기는 원본을 따른다 (기본 2칸).
 */
export function addNodePostgresDependencies(
  packageJsonText: string,
  options: { typescript: boolean },
): { text: string; changed: boolean; notes: string[] } {
  const pkg = JSON.parse(packageJsonText) as PackageJson;
  const notes: string[] = [];
  let changed = false;

  if (!pkg.dependencies?.["pg"]) {
    pkg.dependencies = { ...(pkg.dependencies ?? {}), pg: PG_VERSION };
    changed = true;
  }
  if (options.typescript && !pkg.devDependencies?.["@types/pg"] && !pkg.dependencies?.["@types/pg"]) {
    pkg.devDependencies = { ...(pkg.devDependencies ?? {}), "@types/pg": TYPES_PG_VERSION };
    changed = true;
  }
  for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
    if (isEsmEsbuildBundle(command) && !command.includes("--banner:js")) {
      pkg.scripts![name] = `${command} ${ESM_REQUIRE_BANNER}`;
      notes.push(`scripts.${name}: ESM 번들에서 pg(CommonJS)가 동작하도록 createRequire 배너 추가`);
      changed = true;
    }
  }

  if (!changed) return { text: packageJsonText, changed, notes };
  const indent = /^\{\r?\n([ \t]+)"/.exec(packageJsonText)?.[1] ?? "  ";
  const newline = packageJsonText.includes("\r\n") ? "\r\n" : "\n";
  const text = JSON.stringify(pkg, null, indent).replace(/\n/g, newline) + newline;
  return { text, changed, notes };
}

function isEsmEsbuildBundle(command: string): boolean {
  return /\besbuild\b/.test(command) && command.includes("--bundle") && /--format[= ]esm\b/.test(command);
}

/** requirements.txt 에 psycopg 를 더한다 (이미 있으면 그대로) */
export function addPythonPostgresRequirement(requirements: string): { text: string; changed: boolean } {
  const hasPsycopg = requirements
    .split(/\r?\n/)
    .some((line) => /^\s*psycopg(?:2)?(?:-binary)?\s*(?:\[|[<>=!~;]|$)/i.test(line));
  if (hasPsycopg) return { text: requirements, changed: false };
  const newline = requirements.includes("\r\n") ? "\r\n" : "\n";
  const base = requirements === "" || requirements.endsWith("\n") ? requirements : requirements + newline;
  return { text: `${base}${PSYCOPG_REQUIREMENT}${newline}`, changed: true };
}
