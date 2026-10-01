/**
 * packages/analyzer/src/paths.ts
 *
 * 분석 결과에 들어가는 경로(service path · detected_from · warning path)를 OS 와 무관하게 만든다.
 * Windows 의 path API 는 역슬래시를 쓰고, fast-glob 은 어느 OS 에서든 "/" 를 쓴다.
 * 테스트에서 path.win32 / path.posix 를 주입할 수 있게 path 모듈을 인자로 받는다.
 */

import * as nodePath from "node:path";

type PathApi = Pick<typeof nodePath, "relative" | "sep">;

/** OS 구분자를 "/" 로 */
export function toPosix(p: string, path: PathApi = nodePath): string {
  return p.split(path.sep).join("/");
}

/** from 기준 to 의 상대 경로, "/" 구분 */
export function relativePosix(from: string, to: string, path: PathApi = nodePath): string {
  return toPosix(path.relative(from, to), path);
}
