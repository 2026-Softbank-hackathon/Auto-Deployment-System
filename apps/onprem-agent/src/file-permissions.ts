/**
 * 그룹 · 다른 사용자에게 열린 권한 비트가 있는지 본다 (700 · 600 강제).
 * Windows는 POSIX 권한 비트 대신 ACL로 접근을 막고, Node가 돌려주는 mode는 읽기 전용 여부만 담아
 * 항상 열린 것처럼 보이므로 검사하지 않는다. 기본 상태 디렉터리(%LOCALAPPDATA%)는 본인 · SYSTEM ·
 * Administrators만 접근할 수 있다.
 */
export function hasLoosePermissions(
  mode: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32" && (mode & 0o077) !== 0;
}
