import { useCallback, useEffect, useState } from 'react';
import { listProjectDeployments, listProjects, type ProjectDeploymentSummary, type ProjectSummary } from '../../api/deployment-api';
import { deploymentStatusView } from '../deployment-status/status-view';
import { readCache, writeCache } from '../../lib/page-cache';
import { isStalled } from './format';

/**
 * 전역 배포 목록 API가 없어서 GET /projects → 최근 프로젝트별 GET /projects/:id/deployments 로 모은다.
 * 프로젝트는 한 애플리케이션의 배포 이력을 묶는 단위라 한 프로젝트에 배포가 여러 건 쌓인다 (프로젝트당 최근 20건).
 */
const PROJECT_PAGE_SIZE = 100;
const MAX_PROJECT_PAGES = 5;
const RECENT_PROJECT_LIMIT = 20;
const DEPLOYMENTS_PER_PROJECT = 20;
const ACTIVE_REFRESH_MS = 10_000;

export interface DeploymentListItem extends ProjectDeploymentSummary { projectName: string }

const LIST_CACHE_KEY = 'deployment-list';
interface CachedList { items: DeploymentListItem[]; partialFailures: number; loadedAt: number }

type ListState =
  | { phase: 'loading' }
  | { phase: 'error'; error: unknown }
  | { phase: 'ready'; items: DeploymentListItem[]; partialFailures: number; loadedAt: number };

async function loadAllProjects(): Promise<ProjectSummary[]> {
  const projects: ProjectSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PROJECT_PAGES; page += 1) {
    const result = await listProjects({ limit: PROJECT_PAGE_SIZE, cursor });
    projects.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return projects;
}

function byNewest(a: { id: string; createdAt: string }, b: { id: string; createdAt: string }): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt) || Number(b.id) - Number(a.id);
}

export async function loadDeployments(): Promise<{ items: DeploymentListItem[]; partialFailures: number }> {
  const recentProjects = (await loadAllProjects()).sort(byNewest).slice(0, RECENT_PROJECT_LIMIT);
  const results = await Promise.allSettled(recentProjects.map(async (project) => {
    const page = await listProjectDeployments(project.id, { limit: DEPLOYMENTS_PER_PROJECT });
    return page.items.map((deployment) => ({ ...deployment, projectName: project.name }));
  }));
  const failures = results.filter((result) => result.status === 'rejected');
  if (recentProjects.length > 0 && failures.length === results.length) {
    const reason = (failures[0] as PromiseRejectedResult).reason;
    throw reason;
  }
  const items = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])).sort(byNewest);
  // 전역 알림도 이 함수로 목록을 읽으므로, 여기서 캐시해 두면 배포 현황에 들어올 때 최신에 가까운 값이 이미 있다.
  writeCache<CachedList>(LIST_CACHE_KEY, { items, partialFailures: failures.length, loadedAt: Date.now() });
  return { items, partialFailures: failures.length };
}

export function useDeploymentList() {
  // 직전에 받은 목록이 있으면 먼저 보여 주고, 바로 다시 읽어 바꿔 끼운다 (화면을 옮길 때마다 "불러오는 중"이 뜨지 않게).
  const [state, setState] = useState<ListState>(() => {
    const cached = readCache<CachedList>(LIST_CACHE_KEY);
    return cached ? { phase: 'ready', ...cached } : { phase: 'loading' };
  });

  const refresh = useCallback(async () => {
    try {
      const { items, partialFailures } = await loadDeployments();
      setState({ phase: 'ready', items, partialFailures, loadedAt: Date.now() });
    } catch (error) {
      setState({ phase: 'error', error });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 진행 중인 배포가 있으면 실제 상태를 다시 조회한다 (진행률을 추정하지 않는다). 멈춘 배포만 남았으면 반복 조회하지 않는다.
  const hasActive = state.phase === 'ready' && state.items.some((item) => deploymentStatusView(item.status).outcome === 'active' && !isStalled(true, item.createdAt, state.loadedAt));
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, ACTIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [hasActive, refresh]);

  const retry = useCallback(() => { setState({ phase: 'loading' }); void refresh(); }, [refresh]);

  return { state, retry, /** 화면을 비우지 않고 다시 읽는다 */ refresh: () => { void refresh(); } };
}
