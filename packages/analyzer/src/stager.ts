/**
 * packages/analyzer/src/stager.ts
 *
 * 소스 경로 검증 및 스캔 준비.
 * dry-run: 로컬 디렉터리 경로 검증만 수행.
 * unzip: .zip 파일을 임시 폴더(또는 지정 폴더)에 해제.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";

import * as unzipper from "unzipper";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StageOptions = {
  /** 동작 모드. 기본값 "dry-run" (기존 동작 유지). */
  mode?: "dry-run" | "unzip";
  /**
   * unzip 모드 전용 — 해제 대상 폴더.
   * 미지정 시 os.tmpdir() 아래 랜덤 폴더를 생성한다.
   */
  destDir?: string;
};

export type StageResult = {
  /** dry-run: 입력 경로 그대로. unzip: 해제된 폴더 경로. */
  resolvedPath: string;
  /** unzip 시 원본 zip 파일의 sha256 hex digest. */
  sha256?: string;
  /** unzip 시 원본 zip 파일 크기 (bytes). */
  sizeBytes?: number;
  /** unzip 시 임시 폴더를 삭제하는 정리 함수. */
  cleanup?: () => Promise<void>;
  /** 기존 호환 필드 */
  isDirectory: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 파일을 스트리밍해서 sha256 hex digest를 계산한다. */
async function computeSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const readable = createReadStream(filePath);
  await pipeline(readable, async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
      yield chunk as Buffer;
    }
  });
  return hash.digest("hex");
}

/** zip 엔트리의 정규화 경로가 destDir 안에 있는지 검사한다 (zip slip 방지). */
function isSafeEntry(entryPath: string, destDir: string): boolean {
  if (entryPath.includes("..")) return false;
  const normalized = path.normalize(path.join(destDir, entryPath));
  const normalizedDest = path.normalize(destDir);
  return (
    normalized === normalizedDest ||
    normalized.startsWith(normalizedDest + path.sep)
  );
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * sourcePath를 스테이지한다.
 *
 * - dry-run (기본): 경로 존재 확인 후 resolvedPath 반환.
 * - unzip: .zip 파일을 destDir(또는 임시 폴더)에 해제하고 결과 반환.
 *
 * @throws Error — 경로가 존재하지 않거나 unzip 모드에서 파일이 아닌 경우
 */
export async function stage(
  sourcePath: string,
  opts: StageOptions = {}
): Promise<StageResult> {
  const mode = opts.mode ?? "dry-run";
  const resolvedSource = path.resolve(sourcePath);

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(resolvedSource);
  } catch {
    throw new Error(`analyzer: sourcePath not found: ${resolvedSource}`);
  }

  // dry-run: 디렉터리만 허용 (기존 동작 유지)
  if (mode === "dry-run") {
    if (!stats.isDirectory()) {
      throw new Error(
        `analyzer: sourcePath must be a directory (use mode="unzip" for zip files): ${resolvedSource}`
      );
    }
    return { resolvedPath: resolvedSource, isDirectory: true };
  }

  // unzip mode
  if (!stats.isFile()) {
    throw new Error(
      `analyzer: unzip mode requires a file path, got: ${resolvedSource}`
    );
  }

  // sha256 + size (스트리밍, 대용량 대응)
  const [sha256, sizeBytes] = await Promise.all([
    computeSha256(resolvedSource),
    Promise.resolve(stats.size),
  ]);

  const sha256Short = sha256.slice(0, 12);
  const destDir =
    opts.destDir ?? path.join(os.tmpdir(), `camellia-stage-${sha256Short}`);

  await mkdir(destDir, { recursive: true });

  // unzipper.Open.file(): 중앙 디렉터리를 먼저 읽어 엔트리 목록 취득
  // → Parse 스트림보다 안정적이고 랜덤 접근이 가능하다.
  const directory = await unzipper.Open.file(resolvedSource);

  await Promise.all(
    directory.files.map(async (file) => {
      // 역슬래시 구분 엔트리(Windows PowerShell 5.1 Compress-Archive 등)도 OS 와 무관하게 "/" 로 — unzipper Extract 와 같은 처리
      const entryPath = file.path.replace(/\\/g, "/");

      // zip slip 방지: ".." 포함 또는 destDir 탈출 경로는 skip
      if (!isSafeEntry(entryPath, destDir)) {
        process.stderr.write(`[stager] skip unsafe zip entry: ${entryPath}\n`);
        return;
      }

      const fullPath = path.join(destDir, entryPath);

      if (file.type === "Directory") {
        await mkdir(fullPath, { recursive: true });
        return;
      }

      await mkdir(path.dirname(fullPath), { recursive: true });

      await new Promise<void>((resolve, reject) => {
        const readStream = file.stream();
        const writeStream = createWriteStream(fullPath);
        readStream.pipe(writeStream);
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
        readStream.on("error", reject);
      });
    })
  );

  const cleanup = async (): Promise<void> => {
    await rm(destDir, { recursive: true, force: true });
  };

  return {
    resolvedPath: destDir,
    isDirectory: true,
    sha256,
    sizeBytes,
    cleanup,
  };
}
