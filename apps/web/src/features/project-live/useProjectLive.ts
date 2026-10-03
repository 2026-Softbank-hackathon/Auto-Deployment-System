import { useCallback, useEffect, useRef, useState } from 'react';
import { DeploymentApiError, getProject, listProjectDeployments, type ProjectDeletion, type ProjectDeploymentSummary, type ProjectLiveDeployment } from '../../api/deployment-api';
import { readCache, writeCache } from '../../lib/page-cache';

/** 서버가 한 번에 주는 최대 건수. 이 안에서 검색 · 페이지 나누기를 한다. */
export const DEPLOYMENTS_SHOWN = 100;
const POLL_MS = 2000;

export interface DeploymentsSnapshot { items: ProjectDeploymentSummary[]; loadedAt: number; more?: boolean }
/** 실행 환경이 온프레미스에서 AWS 로 바뀐 것을 화면이 보고 있는 동안 확인했을 때 */
export interface LiveSwitch { fromDeploymentId: string; toDeploymentId: string }

/**
 * 앱 상세가 보고 있는 동안, 지금 서비스 중인 배포(project.live)와 배포 이력을 2초마다 다시 읽는다.
 * 온프레미스 장애로 서버가 AWS 대기 배포로 자동 전환하면 새 배포가 만들어지지 않고 live 만 바뀌므로(#349),
 * 화면은 항상 서버의 live · isLive 를 기준으로 그리고, 최근 배포(latest)로 LIVE 를 추정하지 않는다.
 *
 *  - 화면이 보일 때만 읽고, 다시 보이게 되면 바로 한 번 읽는다
 *  - 앞선 요청이 끝나기 전에는 다시 보내지 않는다
 *  - 읽지 못해도 이미 보여 주던 값은 지우지 않는다 (처음부터 못 읽은 배포 이력만 오류로 알린다)
 *  - 첫 조회 결과는 기준으로만 삼고, 그 뒤 온프레미스 → AWS 로 바뀐 것을 확인했을 때 한 번만 알린다(liveSwitch)
 *  - 앱이 지워졌으면(404) onGone
 * 서버는 전환 이유나 진행 상태를 알려 주지 않으므로, 화면은 "바뀌었다"는 사실만 말한다.
 */
export function useProjectLive(projectId: string, enabled: boolean, onGone: () => void) {
  const liveKey = `project-live:${projectId}`;
  const deploymentsKey = `project-deployments:${projectId}`;
  const [live, setLive] = useState<ProjectLiveDeployment | null | undefined>(() => readCache<ProjectLiveDeployment | null>(liveKey));
  const [deletion, setDeletion] = useState<ProjectDeletion | null>(null);
  const [deployments, setDeployments] = useState<DeploymentsSnapshot | { error: unknown } | null>(() => readCache<DeploymentsSnapshot>(deploymentsKey) ?? null);
  const [liveSwitch, setLiveSwitch] = useState<LiveSwitch | null>(null);

  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;
  /** 진행 중인 요청이 있는지 (겹쳐 보내지 않는다) */
  const busy = useRef(false);
  /** 서버에서 마지막으로 확인한 live. undefined = 아직 한 번도 못 받음 (캐시 값은 기준으로 쓰지 않는다) */
  const confirmed = useRef<ProjectLiveDeployment | null | undefined>(undefined);
  /** 화면을 옮기거나 다른 앱으로 바뀐 뒤에 도착한 응답을 버리기 위한 번호 */
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const mine = generation.current;
    try {
      const [project, page] = await Promise.allSettled([getProject(projectId), listProjectDeployments(projectId, { limit: DEPLOYMENTS_SHOWN })]);
      if (mine !== generation.current) return;

      if (project.status === 'fulfilled') {
        const next = project.value.live;
        const before = confirmed.current;
        if (before !== undefined && before?.environmentType === 'onprem' && next?.environmentType === 'aws' && before.deploymentId !== next.deploymentId) {
          setLiveSwitch({ fromDeploymentId: before.deploymentId, toDeploymentId: next.deploymentId });
        }
        confirmed.current = next;
        writeCache(liveKey, next);
        setLive(next);
        setDeletion(project.value.deletion);
      } else if (project.reason instanceof DeploymentApiError && project.reason.status === 404) {
        onGoneRef.current();
      }

      if (page.status === 'fulfilled') {
        const next: DeploymentsSnapshot = { items: page.value.items, loadedAt: Date.now(), more: page.value.nextCursor !== null };
        writeCache(deploymentsKey, next);
        setDeployments(next);
      } else {
        // 이미 보여 주던 이력이 있으면 그대로 둔다. 한 번도 못 읽었을 때만 오류를 보여 준다.
        setDeployments((current) => (current !== null && !('error' in current) ? current : { error: page.reason }));
      }
    } finally {
      busy.current = false;
    }
  }, [projectId, liveKey, deploymentsKey]);

  useEffect(() => {
    if (!enabled) return;
    confirmed.current = undefined;
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      generation.current += 1;
      busy.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, load]);

  const dismissLiveSwitch = useCallback(() => setLiveSwitch(null), []);
  return { live, deletion, deployments, liveSwitch, dismissLiveSwitch, /** 지금 바로 다시 읽는다 (재배포 · 취소 · 주소 변경 뒤) */ refresh: load };
}
