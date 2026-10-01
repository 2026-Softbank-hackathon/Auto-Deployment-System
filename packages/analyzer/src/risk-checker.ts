/**
 * packages/analyzer/src/risk-checker.ts
 *
 * ANL-06 운영 위험 진단.
 * - 하드코딩 시크릿 (aws_secret_access_key, api key, password, token 등)
 * - Dockerfile 루트 실행 (USER 지시자 없음)
 *
 * D-50: 값 자체는 warnings 메시지에 포함하지 않는다 (LLM 전송·로깅 유출 방지).
 * 경고 코드: ANL-06-HARDCODED-SECRET, ANL-06-DOCKER-ROOT
 */

import { readFile } from "node:fs/promises";
import fg from "fast-glob";

import type { Warning } from "./types.js";
import { relativePosix as relative } from "./paths.js";

// 하드코딩 시크릿 정규식. 값은 캡처하지 않고 위치·키 이름만 남긴다.
const SECRET_PATTERNS: Array<{ code: string; label: string; re: RegExp }> = [
  {
    code: "aws_access_key",
    label: "AWS Access Key ID",
    re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    code: "aws_secret",
    label: "AWS Secret Access Key",
    re: /(?:aws_secret_access_key|aws_secret|SecretAccessKey)\s*[=:]\s*['"]?[A-Za-z0-9/+]{40}['"]?/i,
  },
  {
    code: "generic_secret",
    label: "하드코딩된 비밀값",
    re: /\b(password|passwd|secret|token|api[_-]?key|apikey)\s*[=:]\s*['"][^'"\s]{6,}['"]/i,
  },
  {
    code: "private_key",
    label: "PEM 형식 개인키",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
];

// 코드 파일만 스캔. .env* 는 이미 detectors/env.ts 가 키만 뽑음 → 여기선 제외.
const SCAN_GLOBS = [
  "**/*.js",
  "**/*.ts",
  "**/*.mjs",
  "**/*.cjs",
  "**/*.jsx",
  "**/*.tsx",
  "**/*.py",
  "**/*.rb",
  "**/*.go",
  "**/*.java",
  "**/*.rs",
  "**/*.yml",
  "**/*.yaml",
  "**/*.json",
];

const SCAN_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
  "**/__pycache__/**",
  "**/venv/**",
  "**/.venv/**",
  "**/target/**",
  "**/vendor/**",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
];

export type RiskCheckResult = {
  warnings: Warning[];
};

/**
 * 서비스 디렉터리 하나를 스캔해 하드코딩 시크릿 + Dockerfile 루트 실행을 검사한다.
 * 값은 warnings 메시지에 담지 않는다 (파일:라인 + 카테고리만).
 */
export async function checkRisks(serviceDir: string): Promise<RiskCheckResult> {
  const warnings: Warning[] = [];

  // 1. 하드코딩 시크릿 스캔
  const files = await fg(SCAN_GLOBS, {
    cwd: serviceDir,
    absolute: true,
    onlyFiles: true,
    ignore: SCAN_IGNORE,
    deep: 6,
  });

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (content.length > 512 * 1024) continue; // 500KB 이상 스킵 (min.js 등)

    const rel = relative(serviceDir, file);
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(line)) {
          warnings.push({
            code: "ANL-06-HARDCODED-SECRET",
            message: `${p.label} 의심 패턴이 코드에 포함됨 (${p.code}). 환경변수 또는 시크릿 스토리지로 옮기세요.`,
            path: `${rel}:${i + 1}`,
          });
          break; // 한 줄에 여러 패턴 잡혀도 경고 1개
        }
      }
    }
  }

  // 2. Dockerfile 루트 실행 검사
  const dockerfiles = await fg(["**/Dockerfile", "**/Dockerfile.*"], {
    cwd: serviceDir,
    absolute: true,
    onlyFiles: true,
    ignore: SCAN_IGNORE,
    deep: 4,
  });

  for (const df of dockerfiles) {
    let content: string;
    try {
      content = await readFile(df, "utf8");
    } catch {
      continue;
    }
    const rel = relative(serviceDir, df);
    // USER 지시자가 있고 root/0 이 아니어야 통과
    const userMatches = [...content.matchAll(/^\s*USER\s+(\S+)/gim)];
    if (userMatches.length === 0) {
      warnings.push({
        code: "ANL-06-DOCKER-ROOT",
        message: `Dockerfile 에 USER 지시자가 없어 컨테이너가 root 로 실행됩니다. 비-root 사용자를 지정하세요.`,
        path: rel,
      });
      continue;
    }
    const lastUser = userMatches[userMatches.length - 1]![1]!.toLowerCase();
    if (lastUser === "root" || lastUser === "0") {
      warnings.push({
        code: "ANL-06-DOCKER-ROOT",
        message: `Dockerfile 마지막 USER 가 root 입니다. 비-root 사용자로 실행하세요.`,
        path: rel,
      });
    }
  }

  return { warnings };
}
