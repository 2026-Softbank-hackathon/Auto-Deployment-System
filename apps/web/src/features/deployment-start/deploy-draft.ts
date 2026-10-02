import type { AppChoice } from './AppChooser';

/**
 * 간단 배포에서 고르던 것(ZIP · 앱 · 연결 · 배포 전 확인)을 화면을 떠나 있는 동안 기억한다.
 * 연결을 등록하러 갔다 오거나 다른 화면을 잠깐 봤다 와도 ZIP을 다시 올리지 않게 하기 위해서다.
 * 메모리에만 둔다 — 파일은 저장소에 넣을 수 없고, 새로고침하거나 탭을 닫으면 사라지는 게 맞다. 배포를 시작하면 비운다.
 */
export interface DeployDraft {
  file: File | null;
  choice: AppChoice;
  /** 사용자가 앱 칸을 직접 바꿨는지 */
  appTouched: boolean;
  /** 새 앱 이름을 직접 고쳤는지 */
  nameEdited: boolean;
  /** 직접 고른 연결. 고르지 않았으면 null (기본 연결을 따른다) */
  connectionId: string | null;
  reviewFirst: boolean;
}

let draft: DeployDraft | null = null;

export function readDeployDraft(): DeployDraft | null { return draft; }
export function saveDeployDraft(next: DeployDraft): void { draft = next; }
export function clearDeployDraft(): void { draft = null; }
