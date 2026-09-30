/**
 * packages/analyzer/src/detectors/nodejs.ts
 *
 * Node.js 서비스 감지기.
 *
 * 감지 규칙:
 *   - package.json 존재 → language=node
 *   - dependencies에 express/fastify/hono/@nestjs/core/next → framework
 *   - scripts.start or main 필드 → command 추정
 *   - server.js/index.js/app.js 에서 .listen(<port>) 정규식 → port
 *   - 못 찾으면 unresolved 기록
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import fg from "fast-glob";
import type { UnresolvedField, Warning } from "../types.js";

export type NodeDetectResult = {
  detected: boolean;
  framework?: string;
  port?: number;
  command?: string[];
  envNames: string[];
  detectedFrom: string[];
  unresolved: UnresolvedField[];
  warnings: Warning[];
};

// framework 감지 우선순위: 키 = dep 이름, 값 = 표준화 이름
const FRAMEWORK_DEPS: Record<string, string> = {
  "@nestjs/core": "nestjs",
  "next": "next",
  "fastify": "fastify",
  "express": "express",
  "hono": "hono",
  "koa": "koa",
};

export async function detectNodejs(serviceDir: string): Promise<NodeDetectResult> {
  const pkgPath = join(serviceDir, "package.json");
  const detectedFrom: string[] = [];
  const unresolved: UnresolvedField[] = [];
  const warnings: Warning[] = [];

  let pkgRaw: string;
  try {
    pkgRaw = await readFile(pkgPath, "utf8");
  } catch {
    return {
      detected: false,
      envNames: [],
      detectedFrom: [],
      unresolved: [],
      warnings: [],
    };
  }

  detectedFrom.push("package.json");

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
  } catch {
    warnings.push({ code: "ANL-PKG-PARSE", message: "package.json parse failed", path: pkgPath });
    return { detected: true, envNames: [], detectedFrom, unresolved, warnings };
  }

  // ------------------------------------------------------------------
  // Framework detection
  // ------------------------------------------------------------------
  const allDeps: Record<string, string> = {
    ...((pkg["dependencies"] as Record<string, string>) ?? {}),
    ...((pkg["devDependencies"] as Record<string, string>) ?? {}),
  };

  let framework: string | undefined;
  for (const [dep, stdName] of Object.entries(FRAMEWORK_DEPS)) {
    if (dep in allDeps) {
      framework = stdName;
      detectedFrom.push(`package.json dependencies.${dep}`);
      break;
    }
  }

  // ------------------------------------------------------------------
  // Command detection: scripts.start or main field
  // ------------------------------------------------------------------
  let command: string[] | undefined;
  const scripts = pkg["scripts"] as Record<string, string> | undefined;
  if (scripts?.["start"]) {
    command = scripts["start"].split(/\s+/);
    detectedFrom.push("package.json scripts.start");
  } else if (typeof pkg["main"] === "string") {
    command = ["node", pkg["main"] as string];
    detectedFrom.push("package.json main");
  }

  // ------------------------------------------------------------------
  // Port detection: scan common entry files for .listen(<port>)
  // ------------------------------------------------------------------
  const entryFiles = await fg(["server.js", "index.js", "app.js", "src/server.js", "src/index.js", "src/app.js"], {
    cwd: serviceDir,
    absolute: true,
    onlyFiles: true,
    deep: 2,
  });

  // Also check the main file if specified
  if (typeof pkg["main"] === "string") {
    const mainAbs = join(serviceDir, pkg["main"] as string);
    if (!entryFiles.includes(mainAbs)) {
      entryFiles.push(mainAbs);
    }
  }

  let port: number | undefined;
  for (const file of entryFiles) {
    const detected = await scanPortListen(file);
    if (detected !== undefined) {
      port = detected;
      const rel = file.replace(serviceDir + "/", "");
      detectedFrom.push(`${rel} (.listen(${port}))`);
      break;
    }
  }

  if (port === undefined) {
    unresolved.push({
      path: "services.<name>.port",
      reason: "No .listen(<port>) pattern found in entry files",
    });
  }

  // ------------------------------------------------------------------
  // Env names from source files
  // ------------------------------------------------------------------
  const envNames = await scanNodeEnvNames(serviceDir);

  return {
    detected: true,
    framework,
    port,
    command,
    envNames,
    detectedFrom,
    unresolved,
    warnings,
  };
}

/**
 * 파일에서 app.listen(<port>) 또는 server.listen(<port>) 패턴을 스캔.
 * 숫자 리터럴만 감지. 변수는 unresolved 처리.
 */
async function scanPortListen(filePath: string): Promise<number | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }

  // Match: .listen(3000) or .listen(3000, or .listen(PORT, ...
  const re = /\.listen\(\s*(\d+)/g;
  const match = re.exec(content);
  if (match) {
    return parseInt(match[1], 10);
  }
  return undefined;
}

/**
 * Node.js 소스에서 process.env.X 패턴으로 환경변수 이름 추출.
 */
async function scanNodeEnvNames(serviceDir: string): Promise<string[]> {
  const jsFiles = await fg(["**/*.js", "**/*.ts", "**/*.mjs", "**/*.cjs"], {
    cwd: serviceDir,
    absolute: true,
    onlyFiles: true,
    ignore: ["**/node_modules/**", "**/dist/**"],
    deep: 4,
  });

  const names = new Set<string>();
  const re = /process\.env\.([A-Z_][A-Z0-9_]*)/g;

  for (const file of jsFiles) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      names.add(match[1]);
    }
    re.lastIndex = 0;
  }

  return [...names].sort();
}
