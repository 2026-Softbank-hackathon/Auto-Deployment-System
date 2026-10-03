import { useCallback, useEffect, useRef, useState } from 'react';
import { listProjects, type ProjectSummary } from '../../api/deployment-api';
import { deploymentStatusView } from '../deployment-status/status-view';
import { readCache, writeCache } from '../../lib/page-cache';
import { isStalled } from './format';

/**
 * 대시보드 · 진행 중 띠 · 전역 알림이 함께 쓰는 앱(프로젝트) 목록.
 * GET /projects 항목에 지금 서비스 중인 배포(live)와 최근 배포(latest)가 들어 있어서, 프로젝트마다 따로 묻지 않는다.
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const ACTIVE_REFRESH_MS = 10_000;
/** 대시보드가 보고 있는 동안 다시 읽는 주기. 자동 전환(#349)은 새 배포 없이 live 만 바뀌므로, 진행 중인 배포가 없어도 읽어야 보인다 */
export const LIVE_REFRESH_MS = 5_000;
const CACHE_KEY = 'project-list';

interface CachedList { projects: ProjectSummary[]; loadedAt: number }

type ListState =
  | { phase: 'loading' }
  | { phase: 'error'; error: unknown }
  | { phase: 'ready'; projects: ProjectSummary[]; loadedAt: number };

/** 최근에 움직임이 있는 앱(최근 배포, 없으면 만든 시각)부터 */
function lastActivity(project: ProjectSummary): number {
  return Date.parse(project.latest?.createdAt ?? project.createdAt);
}

export async function loadProjects(): Promise<ProjectSummary[]> {
  const projects: ProjectSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await listProjects({ limit: PAGE_SIZE, cursor });
    projects.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  projects.sort((a, b) => lastActivity(b) - lastActivity(a) || Number(b.id) - Number(a.id));
  // 전역 알림도 이 함수로 읽으므로, 여기서 캐시해 두면 대시보드에 들어올 때 최신에 가까운 값이 이미 있다.
  writeCache<CachedList>(CACHE_KEY, { projects, loadedAt: Date.now() });
  return projects;
}

/** 최근 배포가 진행 중인지. 시작한 지 2시간이 넘은 배포는 멈춘 것으로 보고 뺀다. */
export function latestActive(project: ProjectSummary, now: number): boolean {
  return project.latest !== null && deploymentStatusView(project.latest.status).outcome === 'active' && !isStalled(true, project.latest.createdAt, now);
}

/**
 * @param liveRefreshMs 주면 화면이 보이는 동안 이 주기로 계속 다시 읽고, 다시 보이게 되면 바로 한 번 읽는다 (대시보드).
 *   없으면 진행 중인 배포 · 삭제 중인 앱이 있을 때만 다시 읽는다 (진행 중 띠).
 */
export function useProjectList(liveRefreshMs?: number) {
  // 직전에 받은 목록이 있으면 먼저 보여 주고, 바로 다시 읽어 바꿔 끼운다.
  const [state, setState] = useState<ListState>(() => {
    const cached = readCache<CachedList>(CACHE_KEY);
    return cached ? { phase: 'ready', ...cached } : { phase: 'loading' };
  });

  /** 진행 중인 요청이 있는지 (겹쳐 보내지 않는다) */
  const busy = useRef(false);
  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const projects = await loadProjects();
      setState({ phase: 'ready', projects, loadedAt: Date.now() });
    } catch (error) {
      // 이미 보여 주던 목록이 있으면 일시적인 조회 실패로 지우지 않는다. 다음 주기에 다시 읽는다.
      setState((current) => (current.phase === 'ready' ? current : { phase: 'error', error }));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 진행 중인 배포나 삭제 중인 앱이 있을 때만 목록을 다시 읽는다 (진행률을 추정하지 않는다). 삭제가 끝난 앱은 목록에서 빠진다.
  const hasActive = state.phase === 'ready' && state.projects.some((project) => latestActive(project, state.loadedAt) || project.deletion?.status === 'deleting');
  useEffect(() => {
    if (liveRefreshMs === undefined && !hasActive) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, liveRefreshMs ?? ACTIVE_REFRESH_MS);
    if (liveRefreshMs === undefined) return () => window.clearInterval(timer);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [hasActive, refresh, liveRefreshMs]);

  const retry = useCallback(() => { setState({ phase: 'loading' }); void refresh(); }, [refresh]);

  return { state, retry, /** 화면을 비우지 않고 다시 읽는다 */ refresh };
}
