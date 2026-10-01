import { useCallback, useEffect, useState } from 'react';
import { listProjectDeployments, listProjects, type ProjectDeploymentSummary, type ProjectSummary } from '../../api/deployment-api';
import { deploymentStatusView } from '../deployment-status/status-view';

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

async function loadDeployments(): Promise<{ items: DeploymentListItem[]; partialFailures: number }> {
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
  return { items, partialFailures: failures.length };
}

export function useDeploymentList() {
  const [state, setState] = useState<ListState>({ phase: 'loading' });

  const refresh = useCallback(async () => {
    try {
      const { items, partialFailures } = await loadDeployments();
      setState({ phase: 'ready', items, partialFailures, loadedAt: Date.now() });
    } catch (error) {
      setState({ phase: 'error', error });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 진행 중인 배포가 있으면 실제 상태를 다시 조회한다 (진행률을 추정하지 않는다).
  const hasActive = state.phase === 'ready' && state.items.some((item) => deploymentStatusView(item.status).outcome === 'active');
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, ACTIVE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [hasActive, refresh]);

  const retry = useCallback(() => { setState({ phase: 'loading' }); void refresh(); }, [refresh]);

  return { state, retry };
}
