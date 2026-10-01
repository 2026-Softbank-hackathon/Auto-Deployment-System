/**
 * packages/analyzer/src/service-splitter.ts
 *
 * 소스 루트를 스캔해서 서비스 경계(후보 디렉터리 목록)를 반환한다.
 *
 * 규칙:
 *   1. 루트에 package.json 하나만 있으면 단일 서비스 (루트 자체).
 *   2. services/{name}/package.json, packages/{name}/package.json, apps/{name}/package.json 패턴
 *      → 각 하위 디렉터리를 별도 서비스로 분리.
 *   3. docker-compose.yml / docker-compose.yaml 존재 시 services 섹션 파싱해서
 *      이름·image·ports 추출 (YAML 파서 없이 정규식 기반 간이 파싱).
 *   4. Python 루트(requirements.txt / pyproject.toml / Pipfile) — 단일 서비스.
 */

import { readFile } from "node:fs/promises";
import { join, relative as nativeRelative, sep } from "node:path";
import fg from "fast-glob";

/** 상대 경로를 OS 와 무관하게 "/" 구분으로 (Windows 의 path.relative 는 역슬래시를 쓴다) */
function relative(from: string, to: string): string {
  return nativeRelative(from, to).split(sep).join("/");
}

export type ServiceRoot = {
  /** 서비스 이름 (폴더 이름 또는 docker-compose service 이름) */
  name: string;
  /** 절대 경로 */
  absPath: string;
  /** 소스 루트 기준 상대 경로 */
  relPath: string;
  /** 감지 방식 */
  source: "package.json" | "python" | "docker-compose" | "root";
};

export async function splitServices(rootPath: string): Promise<ServiceRoot[]> {
  const services: ServiceRoot[] = [];

  // ------------------------------------------------------------------
  // 1. docker-compose 먼저 확인 (멀티 서비스 override)
  // ------------------------------------------------------------------
  const composeServices = await parseDockerCompose(rootPath);
  if (composeServices.length > 0) {
    return composeServices;
  }

  // ------------------------------------------------------------------
  // 2. 모노레포 패턴: services/*/package.json, packages/*/package.json, apps/*/package.json
  // ------------------------------------------------------------------
  const monoPatterns = [
    "services/*/package.json",
    "packages/*/package.json",
    "apps/*/package.json",
  ];
  const monoFiles = await fg(monoPatterns, {
    cwd: rootPath,
    absolute: true,
    onlyFiles: true,
    deep: 2,
  });

  // 루트 자체의 package.json은 제외
  const filtered = monoFiles.filter((f) => {
    const rel = relative(rootPath, f);
    // depth 2 이상 (e.g. services/api/package.json) 만
    return rel.split("/").length >= 2;
  });

  if (filtered.length > 0) {
    for (const pkgFile of filtered) {
      const parts = relative(rootPath, pkgFile).split("/");
      const serviceDir = pkgFile.replace(/\/package\.json$/, "");
      const name = await readPackageName(pkgFile, parts[parts.length - 2] ?? "service");
      services.push({
        name,
        absPath: serviceDir,
        relPath: relative(rootPath, serviceDir),
        source: "package.json",
      });
    }
    return services;
  }

  // ------------------------------------------------------------------
  // 3. 루트에 package.json → 단일 Node 서비스
  // ------------------------------------------------------------------
  const rootPkg = await fileExists(join(rootPath, "package.json"));
  if (rootPkg) {
    const name = await readPackageName(join(rootPath, "package.json"), rootPath.split("/").pop() ?? "app");
    services.push({
      name,
      absPath: rootPath,
      relPath: ".",
      source: "root",
    });
    return services;
  }

  // ------------------------------------------------------------------
  // 4. 루트에 Python 파일 → 단일 Python 서비스
  // ------------------------------------------------------------------
  const pythonMarkers = ["requirements.txt", "pyproject.toml", "Pipfile"];
  for (const marker of pythonMarkers) {
    if (await fileExists(join(rootPath, marker))) {
      const folderName = rootPath.split("/").pop() ?? "app";
      services.push({
        name: folderName,
        absPath: rootPath,
        relPath: ".",
        source: "python",
      });
      return services;
    }
  }

  // ------------------------------------------------------------------
  // 5. 아무것도 없으면 루트를 unknown 단일 서비스로
  // ------------------------------------------------------------------
  services.push({
    name: rootPath.split("/").pop() ?? "app",
    absPath: rootPath,
    relPath: ".",
    source: "root",
  });
  return services;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function fileExists(path: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageName(pkgPath: string, fallback: string): Promise<string> {
  try {
    const raw = await readFile(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { name?: string };
    return parsed.name?.replace(/^@[^/]+\//, "") ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * docker-compose.yml / docker-compose.yaml 의 services 섹션을 정규식으로 간이 파싱.
 * YAML 파서 의존성 없이 이름·이미지·ports 만 추출한다.
 */
async function parseDockerCompose(rootPath: string): Promise<ServiceRoot[]> {
  const candidates = ["docker-compose.yml", "docker-compose.yaml"];
  let raw: string | null = null;

  for (const fname of candidates) {
    try {
      raw = await readFile(join(rootPath, fname), "utf8");
      break;
    } catch {
      // try next
    }
  }

  if (!raw) return [];

  const services: ServiceRoot[] = [];

  // Match top-level services block: lines at 2-space indent under `services:`
  // Simple heuristic: find `  <name>:` lines that appear after `^services:` and before next top-level key
  const inServicesBlock = extractDockerComposeServiceNames(raw);

  for (const name of inServicesBlock) {
    services.push({
      name,
      absPath: rootPath,
      relPath: ".",
      source: "docker-compose",
    });
  }

  return services;
}

function extractDockerComposeServiceNames(yaml: string): string[] {
  const names: string[] = [];
  const lines = yaml.split("\n");
  let inServices = false;

  for (const line of lines) {
    // Top-level key (no leading spaces)
    if (/^\S/.test(line)) {
      inServices = line.trimEnd() === "services:";
      continue;
    }

    if (!inServices) continue;

    // 2-space indent service name: "  <name>:"
    const match = /^ {2}([a-zA-Z0-9_-]+)\s*:/.exec(line);
    if (match) {
      names.push(match[1]!);
    }
  }

  return names;
}
