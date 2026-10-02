/**
 * packages/analyzer/src/index.ts
 *
 * Public entry point.
 * analyze(sourcePath) → Promise<AnalysisResult>
 *
 * P0 규칙 기반 분석기. AI 호출 없음.
 * 해결 못 한 필드는 unresolved 배열에 담아 반환 (P1 AI 단계에서 채움).
 */

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { stage } from "./stager.js";
import { splitServices } from "./service-splitter.js";
import { detectNodejs } from "./detectors/nodejs.js";
import { detectPython } from "./detectors/python.js";
import { detectDocker } from "./detectors/docker.js";
import { detectDatabase } from "./detectors/database.js";
import { detectEnvNames } from "./detectors/env.js";
import { detectStatic } from "./detectors/static.js";
import { checkRisks } from "./risk-checker.js";
import { buildIr, sanitizeName } from "./ir-builder.js";
import type {
  AnalysisResult,
  ServiceCandidate,
  ResourceCandidate,
  Warning,
  UnresolvedField,
} from "./types.js";
import { fillUnresolved } from "./ai/fill-unresolved.js";
import type { FillOptions, AiFillResult } from "./ai/fill-unresolved.js";

export type { AnalysisResult, ServiceCandidate, ResourceCandidate, Warning, UnresolvedField } from "./types.js";
export type { FillOptions, AiFillResult } from "./ai/fill-unresolved.js";

// Re-export AI helpers so consumers (e.g. apps/worker/handlers/diagnose.ts) can import top-level.
export { createClient, resolveAiProvider, resolveModel } from "./ai/anthropic-client.js";
export type {
  AiProvider,
  AiRole,
  AnthropicLike,
  AnthropicContentBlock,
  AnthropicMessageResponse,
  AnthropicCreateParams,
  ClientOptions,
} from "./ai/anthropic-client.js";
export { redact, redactPayload } from "./ai/redact.js";
export { estimateCost } from "./ai/tokens.js";

/** 정적 사이트 이미지(nginx)가 듣는 포트 (#272) */
export const STATIC_SITE_PORT = 8080;

/**
 * 소스 경로를 스캔해서 IR 초안을 생성한다.
 *
 * @param sourcePath - 분석할 소스 디렉터리 절대/상대 경로
 * @returns AnalysisResult — 서비스·리소스·경고·미해결 필드·IR 초안
 */
export async function analyze(sourcePath: string): Promise<AnalysisResult> {
  // 1. Stage: 경로 검증
  const { resolvedPath } = await stage(sourcePath);

  // 2. Service split: 서비스 경계 감지
  const serviceRoots = await splitServices(resolvedPath);

  const services: ServiceCandidate[] = [];
  const resources: ResourceCandidate[] = [];
  const warnings: Warning[] = [];
  const unresolved: UnresolvedField[] = [];

  // 3. Per-service detection
  for (const svcRoot of serviceRoots) {
    const svcDir = svcRoot.absPath;

    // Run detectors
    const [nodeResult, pyResult, dockerResult] = await Promise.all([
      detectNodejs(svcDir),
      detectPython(svcDir),
      detectDocker(svcDir),
    ]);

    // Gather node deps for database detector
    let nodeDeps: Record<string, string> = {};
    if (nodeResult.detected) {
      try {
        const pkgRaw = await readFile(join(svcDir, "package.json"), "utf8");
        const pkg = JSON.parse(pkgRaw) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        nodeDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      } catch {
        // ignore
      }
    }

    // Gather python packages for database detector
    let pyPackages: string[] = [];
    if (pyResult.detected) {
      // Re-parse requirements to pass to database detector
      const reqPath = join(svcDir, "requirements.txt");
      try {
        const reqRaw = await readFile(reqPath, "utf8");
        pyPackages = reqRaw
          .split("\n")
          .map((l) => l.trim().split(/[>=<!;[]/)[0]!.trim())
          .filter((p) => p.length > 0 && !p.startsWith("#"));
      } catch {
        // try pyproject or Pipfile — already handled in python detector
        pyPackages = [];
      }
    }

    const [dbResult, envResult, riskResult] = await Promise.all([
      detectDatabase(svcDir, nodeDeps, pyPackages),
      detectEnvNames(svcDir),
      checkRisks(svcDir),
    ]);

    // Collect warnings and resources from detectors
    warnings.push(...dbResult.warnings);
    warnings.push(...riskResult.warnings);
    resources.push(...dbResult.resources);

    // Determine language
    let language: ServiceCandidate["language"] = "unknown";
    if (nodeResult.detected) language = "node";
    else if (pyResult.detected) language = "python";

    // Determine primary detection source
    const primaryDetector = nodeResult.detected ? nodeResult : pyResult.detected ? pyResult : null;

    // Merge env names from env detector + language-specific detectors
    const allEnvNames = new Set<string>([
      ...envResult.envNames,
      ...(nodeResult.detected ? nodeResult.envNames : []),
      ...(pyResult.detected ? pyResult.envNames : []),
    ]);

    // Determine port: prefer node/python detector; fallback to docker EXPOSE
    let port = primaryDetector?.port;
    if (port === undefined && dockerResult.exposedPorts.length > 0) {
      port = dockerResult.exposedPorts[0];
    }

    // Determine command: prefer language detector; fallback to docker CMD
    let command = primaryDetector?.command;
    if (!command && dockerResult.command) {
      command = dockerResult.command;
    }

    // Determine service type from framework
    const framework = primaryDetector?.framework;
    const HTTP_FRAMEWORKS = new Set([
      "express", "fastify", "hono", "nestjs", "next",
      "fastapi", "flask", "django", "starlette", "koa", "tornado",
    ]);
    const hasServerFramework = framework !== undefined && HTTP_FRAMEWORKS.has(framework);

    // 정적 사이트 (#272): 서버 없이 index.html 또는 프론트엔드 빌드 결과만 서빙
    const staticResult = await detectStatic(svcDir, {
      hasServerFramework,
      hasPython: pyResult.detected,
      hasDockerfile: dockerResult.detected,
    });

    if (staticResult.detected) {
      services.push({
        name: svcRoot.name,
        path: svcRoot.relPath,
        type: "static",
        framework,
        language,
        // 빌드 결과를 담는 nginx 이미지가 듣는 포트 (서버 코드가 없으니 감지할 포트도 없다)
        port: STATIC_SITE_PORT,
        env_names: [],
        detected_from: [...new Set([...staticResult.detectedFrom, ...(nodeResult.detected ? ["package.json"] : [])])],
        static: {
          ...(staticResult.buildCommand ? { build_command: staticResult.buildCommand } : {}),
          output_dir: staticResult.outputDir,
          spa_fallback: staticResult.spaFallback,
        },
      });
      continue;
    }

    const serviceType: ServiceCandidate["type"] = hasServerFramework ? "http" : "unknown";

    // Collect unresolved from detectors.
    // 감지기는 서비스 이름을 몰라 "services.<name>.…" 자리표시자를 쓴다 → IR 서비스 키로 바꾼다
    // (AI 보완이 이 경로에 그대로 값을 넣으므로 자리표시자면 엉뚱한 서비스가 생긴다)
    const serviceKey = sanitizeName(svcRoot.name);
    unresolved.push(
      ...[
        ...(nodeResult.detected ? nodeResult.unresolved : []),
        ...(pyResult.detected ? pyResult.unresolved : []),
      ].map((u) => ({ ...u, path: u.path.replace("services.<name>.", `services.${serviceKey}.`) })),
    );

    // Build detected_from
    const detectedFrom: string[] = [];
    if (nodeResult.detected) detectedFrom.push(...nodeResult.detectedFrom);
    if (pyResult.detected) detectedFrom.push(...pyResult.detectedFrom);
    if (dockerResult.detected) detectedFrom.push(...dockerResult.detectedFrom);
    if (envResult.detectedFrom.length > 0) detectedFrom.push(...envResult.detectedFrom);

    services.push({
      name: svcRoot.name,
      path: svcRoot.relPath,
      type: serviceType,
      framework,
      language,
      port,
      command,
      dockerfile: dockerResult.dockerfilePath,
      env_names: [...allEnvNames].sort(),
      // `.env.example` 등에서 추출한 default 값 매핑. 코드 scan 추출은 default 없음.
      // 원클릭 복원 (이슈 #137): provision 이 user env_vars 미등록 시 fallback.
      env_defaults:
        Object.keys(envResult.envDefaults).length > 0
          ? { ...envResult.envDefaults }
          : undefined,
      detected_from: [...new Set(detectedFrom)],
    });
  }

  // 4. Determine app-level metadata from root package.json
  const { appName, appVersion } = await readAppMeta(resolvedPath, services);

  // 5. Build IR draft
  const irResult = buildIr({
    appName,
    appVersion,
    services,
    resources,
    warnings,
    unresolved,
  });

  return {
    services,
    resources,
    warnings,
    unresolved: irResult.unresolved,
    ir_draft: irResult.ir_draft,
    ir_valid: irResult.ir_valid,
    ir_errors: irResult.ir_errors,
  };
}

/**
 * analyze() 후 unresolved 필드를 AI로 채운다.
 *
 * @param sourcePath - 분석할 소스 디렉터리 절대/상대 경로
 * @param opts - AI 채우기 옵션 (client 주입, apiKey, model, maxRetries, onUsage)
 * @returns AnalysisResult + ai 필드 (AiFillResult)
 */
export async function analyzeWithAI(
  sourcePath: string,
  opts?: FillOptions
): Promise<AnalysisResult & { ai: AiFillResult }> {
  const analysis = await analyze(sourcePath);
  const ai = await fillUnresolved(analysis, opts ?? {});

  // Merge AI-filled IR back into the result when it's valid
  const merged: AnalysisResult = {
    ...analysis,
    ir_draft: ai.ir_after,
    ir_valid: ai.ir_valid_after,
    ir_errors: ai.ir_errors_after,
    unresolved: ai.still_unresolved,
  };

  return { ...merged, ai };
}

async function readAppMeta(
  rootPath: string,
  services: ServiceCandidate[]
): Promise<{ appName: string; appVersion: string }> {
  try {
    const raw = await readFile(join(rootPath, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { name?: string; version?: string };
    return {
      appName: pkg.name ?? services[0]?.name ?? basename(rootPath),
      appVersion: pkg.version ?? "0.0.1",
    };
  } catch {
    // Python or no package.json
    return {
      appName: services[0]?.name ?? basename(rootPath),
      appVersion: "0.0.1",
    };
  }
}
