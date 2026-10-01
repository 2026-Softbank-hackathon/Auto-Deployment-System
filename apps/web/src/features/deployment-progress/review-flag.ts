/**
 * "배포 전에 포트 확인하기"를 켜고 시작한 배포인지. 간단 배포에서 켜고, 진행 화면이 대상 승인 전에 읽는다.
 * 그 배포 한 건에만 해당하고 탭을 닫으면 사라져야 해서 sessionStorage에 둔다.
 */
const key = (deploymentId: string) => `camellia.reviewBeforeDeploy.${deploymentId}`;

export function requestReview(deploymentId: string): void {
  try { window.sessionStorage.setItem(key(deploymentId), '1'); } catch { /* 저장하지 못하면 확인 없이 진행한다 */ }
}
export function reviewRequested(deploymentId: string): boolean {
  try { return window.sessionStorage.getItem(key(deploymentId)) === '1'; } catch { return false; }
}
export function clearReview(deploymentId: string): void {
  try { window.sessionStorage.removeItem(key(deploymentId)); } catch { /* 무시 */ }
}
