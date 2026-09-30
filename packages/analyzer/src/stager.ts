/**
 * packages/analyzer/src/stager.ts
 *
 * 소스 경로 검증 및 스캔 준비.
 * P0: 로컬 디렉터리를 dry-run 모드로 검사 (실제 복사/zip 해제는 P1).
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export type StageResult = {
  /** 정규화된 절대 경로 */
  resolvedPath: string;
  /** 디렉터리 여부 */
  isDirectory: boolean;
};

/**
 * sourcePath 가 존재하는 디렉터리인지 확인하고 정규화된 경로를 반환한다.
 * P0에서는 로컬 디렉터리만 지원한다. zip/URL은 P1.
 *
 * @throws Error — 경로가 존재하지 않거나 디렉터리가 아닌 경우
 */
export async function stage(sourcePath: string): Promise<StageResult> {
  const resolvedPath = resolve(sourcePath);

  let stats;
  try {
    stats = await stat(resolvedPath);
  } catch {
    throw new Error(`analyzer: sourcePath not found: ${resolvedPath}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(
      `analyzer: sourcePath must be a directory (zip support is P1): ${resolvedPath}`
    );
  }

  return { resolvedPath, isDirectory: true };
}
