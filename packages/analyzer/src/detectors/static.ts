/**
 * packages/analyzer/src/detectors/static.ts
 *
 * 정적 사이트 감지기 (#272).
 *
 * 감지 규칙 (서버 프레임워크 · Python · Dockerfile 이 있으면 정적 사이트로 보지 않는다):
 *   1. package.json 에 프론트엔드 빌드 도구(vite · react-scripts · parcel · vue-cli · astro) + scripts.build
 *      → 빌드 명령(패키지 매니저별) + 결과 폴더(도구 기본값, vite.config 의 build.outDir 우선)
 *   2. 빌드 도구가 있는데 build 스크립트가 없으면 정적 사이트가 아님 (소스를 그대로 서빙할 수 없음)
 *   3. 빌드 도구가 없고 scripts.start 도 없고 루트에 index.html → 소스를 그대로 서빙
 *   4. package.json 이 없고 루트에 index.html → 소스를 그대로 서빙
 * SPA fallback 은 기본으로 켠다 (없는 경로 → index.html). IR 에서 끌 수 있다.
 */

import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type StaticDetectResult = {
  detected: boolean;
  buildCommand?: string;
  outputDir: string;
  spaFallback: boolean;
  detectedFrom: string[];
};

export type StaticDetectContext = {
  /** express · fastify 등 서버 프레임워크를 감지했다 */
  hasServerFramework: boolean;
  /** Python 서비스로 감지했다 */
  hasPython: boolean;
  /** 사용자 Dockerfile 이 있다 — 사용자가 정한 빌드를 그대로 쓴다 */
  hasDockerfile: boolean;
};

/** 결과 폴더 기본값. 앞에 있는 도구가 우선 */
const BUILD_TOOLS: Array<{ dep: string; outputDir: string }> = [
  { dep: "vite", outputDir: "dist" },
  { dep: "react-scripts", outputDir: "build" },
  { dep: "parcel", outputDir: "dist" },
  { dep: "@vue/cli-service", outputDir: "dist" },
  { dep: "astro", outputDir: "dist" },
];

const VITE_CONFIGS = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"];

/** IR output_dir 과 같은 규칙 — 소스 안의 상대 경로만 */
const SAFE_RELATIVE_DIR = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

const NOT_STATIC: StaticDetectResult = {
  detected: false,
  outputDir: ".",
  spaFallback: true,
  detectedFrom: [],
};

export async function detectStatic(
  serviceDir: string,
  context: StaticDetectContext,
): Promise<StaticDetectResult> {
  if (context.hasServerFramework || context.hasPython || context.hasDockerfile) {
    return NOT_STATIC;
  }

  const hasRootIndex = await isFile(join(serviceDir, "index.html"));
  const pkg = await readPackageJson(serviceDir);

  if (!pkg) {
    return hasRootIndex ? plainSite() : NOT_STATIC;
  }

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const tool = BUILD_TOOLS.find((candidate) => candidate.dep in deps);
  const scripts = pkg.scripts ?? {};

  if (tool) {
    if (!scripts["build"]) return NOT_STATIC;
    const configuredOutDir = tool.dep === "vite" ? await readViteOutDir(serviceDir) : undefined;
    return {
      detected: true,
      buildCommand: `${await packageManager(serviceDir)} build`,
      outputDir: configuredOutDir?.dir ?? tool.outputDir,
      spaFallback: true,
      detectedFrom: [
        `package.json dependencies.${tool.dep}`,
        "package.json scripts.build",
        ...(configuredOutDir ? [`${configuredOutDir.file} build.outDir`] : []),
      ],
    };
  }

  if (scripts["start"] || !hasRootIndex) return NOT_STATIC;
  return plainSite();
}

function plainSite(): StaticDetectResult {
  return { detected: true, outputDir: ".", spaFallback: true, detectedFrom: ["index.html"] };
}

type PackageJson = {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

async function readPackageJson(serviceDir: string): Promise<PackageJson | null> {
  try {
    return JSON.parse(await readFile(join(serviceDir, "package.json"), "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

/** lock 파일로 패키지 매니저를 고른다 — 빌드 명령의 접두사 */
async function packageManager(serviceDir: string): Promise<string> {
  if (await isFile(join(serviceDir, "pnpm-lock.yaml"))) return "pnpm run";
  if (await isFile(join(serviceDir, "yarn.lock"))) return "yarn";
  return "npm run";
}

async function readViteOutDir(
  serviceDir: string,
): Promise<{ dir: string; file: string } | undefined> {
  for (const file of VITE_CONFIGS) {
    let content: string;
    try {
      content = await readFile(join(serviceDir, file), "utf8");
    } catch {
      continue;
    }
    const match = /outDir\s*:\s*["'`]([^"'`]+)["'`]/.exec(content);
    const dir = match?.[1]?.replace(/^\.\//, "").replace(/\/$/, "");
    if (dir && SAFE_RELATIVE_DIR.test(dir) && !dir.split("/").includes("..")) {
      return { dir, file };
    }
    return undefined;
  }
  return undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
