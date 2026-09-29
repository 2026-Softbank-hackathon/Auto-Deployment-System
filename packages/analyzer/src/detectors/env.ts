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

export type EnvDetectResult = {
  envNames: string[];
  detectedFrom: string[];
};

export async function detectEnvNames(serviceDir: string): Promise<EnvDetectResult> {
  const names = new Set<string>();
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
    const rel = envFile.replace(serviceDir + "/", "");
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
      names.add(match[1]);
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
        names.add(match[1]);
        pyFound = true;
      }
    }
  }
  if (pyFound) {
    detectedFrom.push("source (os.environ/os.getenv)");
  }

  return {
    envNames: [...names].sort(),
    detectedFrom,
  };
}
