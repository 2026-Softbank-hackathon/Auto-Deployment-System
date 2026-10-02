import type { ProjectDeploymentSummary } from '../../api/deployment-api';
import { sceneTarget, type SceneTarget } from './DeployScene';

/**
 * 이 배포가 어떤 종류인지 — 장면과 코로의 말을 그에 맞게 바꾸는 데 쓴다.
 *   first    처음 배포 (이 앱에 서비스 중인 버전이 없다)
 *   update   새 버전 배포 (같은 환경, 새로 지은 이미지)
 *   redeploy 지금 서비스 중인 버전을 같은 환경에 다시 배포
 *   rollback 이전 버전으로 되돌리기 (같은 환경, 예전 이미지 재사용)
 *   switch   환경 전환 (AWS ↔ 온프레미스)
 * 서버는 "재배포인지"를 따로 알려 주지 않는다. 쓰는 단서는 둘이다:
 *   - 이 앱의 배포 목록 (이 배포 전에 마지막으로 성공한 배포 = 지금까지 서비스하던 버전)
 *   - 빌드 로그의 "빌드 생략 — 배포 #N의 이미지 재사용" 줄 (apps/worker handlers/build.ts)
 */
export type StoryKind = 'first' | 'update' | 'redeploy' | 'rollback' | 'switch';

export interface DeployStory {
  kind: StoryKind;
  /** 지금까지 서비스하던 버전. 없으면 null */
  prev: { label: string; target: SceneTarget } | null;
  /** 전에 만든 이미지를 그대로 쓴다 (빌드 생략이 로그로 확인됨) */
  reused: boolean;
  /** 이 배포가 나르는 이미지의 이름표 (그 이미지를 만든 배포 번호) */
  label: string;
}

/** 빌드 로그 한 줄에서 재사용한 원본 배포 번호를 읽는다. 해당 줄이 아니면 null */
export function readReusedFrom(line: string): string | null {
  return /빌드 생략 — 배포 #(\d+)의 이미지 재사용/.exec(line)?.[1] ?? null;
}

/** 이 배포보다 먼저 만들어진 배포 중 가장 최근에 성공한 것 */
export function previousLive(deploymentId: string, deployments: ProjectDeploymentSummary[]): ProjectDeploymentSummary | null {
  const current = Number(deploymentId);
  return deployments
    .filter((item) => item.status === 'succeeded' && Number(item.id) < current)
    .sort((a, b) => Number(b.id) - Number(a.id))[0] ?? null;
}

export function deployStory(deploymentId: string, target: SceneTarget, prev: ProjectDeploymentSummary | null, reusedFrom: string | null): DeployStory {
  const label = `#${reusedFrom ?? deploymentId}`;
  const reused = reusedFrom !== null;
  if (!prev) return { kind: 'first', prev: null, reused, label };
  const prevTarget = prev.environmentType ?? sceneTarget(prev.targetProfile);
  const kind: StoryKind = prevTarget !== null && target !== null && prevTarget !== target ? 'switch'
    : reusedFrom === null ? 'update'
      : reusedFrom === prev.id ? 'redeploy' : 'rollback';
  return { kind, prev: { label: `#${prev.id}`, target: prevTarget }, reused, label };
}
