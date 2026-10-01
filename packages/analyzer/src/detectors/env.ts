/**
 * packages/analyzer/src/detectors/env.ts
 *
 * 환경변수 이름 감지기.
 *
 * 스캔 대상:
 *   - .env / .env.example / .env.sample → 키 이름 추출
 *   - 코드 파일: process.env.X (Node), os.environ["X"] / os.getenv("X") (Python)
 *
 * 값은 절대 추출하지 않는다 (D-50).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";
import { relativePosix } from "../paths.js";

export type EnvDetectResult = {
  envNames: string[];
  /**
   * `.env.example` 등에서 KEY=value 로 선언된 변수의 default 값.
   * 원클릭 복원 (이슈 #137): 프로젝트에 env_vars 미등록 시 provision 이 fallback.
   */
  envDefaults: Record<string, string>;
  detectedFrom: string[];
};

export async function detectEnvNames(serviceDir: string): Promise<EnvDetectResult> {
  const names = new Set<string>();
  const defaults: Record<string, string> = {};
  const detectedFrom: string[] = [];

  // ------------------------------------------------------------------
  // 1. .env files (keys only)
  // ------------------------------------------------------------------
  const envFiles = await fg(
    [".env", ".env.example", ".env.sample", ".env.local", ".env.development"],
    {
      cwd: serviceDir,
      absolute: true,
      onlyFiles: true,
      dot: true,
      deep: 1,
    }
  );

  for (const envFile of envFiles) {
    let content: string;
    try {
      content = await readFile(envFile, "utf8");
    } catch {
      continue;
    }
    const rel = relativePosix(serviceDir, envFile);
    let foundAny = false;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          names.add(key);
          foundAny = true;
          // default 값 추출 — 앞뒤 공백·따옴표 제거.
          // 비어있으면 (`KEY=`) default 없음으로 간주. 기존 등록 default 는 유지(첫 파일 우선).
          const rawValue = trimmed.slice(eqIdx + 1).trim();
          const unquoted = stripSurroundingQuotes(rawValue);
          if (unquoted.length > 0 && !(key in defaults)) {
            defaults[key] = unquoted;
          }
        }
      }
    }
    if (foundAny) {
      detectedFrom.push(rel);
    }
  }

  // ------------------------------------------------------------------
  // 2. Node.js source: process.env.X
  // ------------------------------------------------------------------
  const jsFiles = await fg(["**/*.js", "**/*.ts", "**/*.mjs", "**/*.cjs"], {
    cwd: serviceDir,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**"],
    deep: 4,
  });

  const nodeRe = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let nodeFound = false;
  for (const file of jsFiles) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    nodeRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = nodeRe.exec(content)) !== null) {
      names.add(match[1]!);
      nodeFound = true;
    }
  }
  if (nodeFound) {
    detectedFrom.push("source (process.env.*)");
  }

  // ------------------------------------------------------------------
  // 3. Python source: os.environ["X"] / os.getenv("X") / os.environ.get("X")
  // ------------------------------------------------------------------
  const pyFiles = await fg(["**/*.py"], {
    cwd: serviceDir,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/__pycache__/**", "**/venv/**", "**/.venv/**"],
    deep: 4,
  });

  const pyPatterns = [
    /os\.environ\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
    /os\.getenv\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
    /os\.environ\.get\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  ];

  let pyFound = false;
  for (const file of pyFiles) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const re of pyPatterns) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(content)) !== null) {
        names.add(match[1]!);
        pyFound = true;
      }
    }
  }
  if (pyFound) {
    detectedFrom.push("source (os.environ/os.getenv)");
  }

  return {
    envNames: [...names].sort(),
    envDefaults: defaults,
    detectedFrom,
  };
}

function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
