import { useCallback, useEffect, useState } from 'react';
import { createProject, getProject, listEnvironments, listProjects, registerAwsEnvironment, type EnvironmentSummary } from '../../api/deployment-api';
import type { DeployTarget } from './TargetToggle';

/**
 * 원클릭 배포가 쓰는 프로젝트. 프로젝트는 배포 단위가 아니라 한 애플리케이션의 배포 이력을 묶는 단위라서
 * 배포마다 새로 만들지 않고 재사용한다 (2026-10-01 팀 결정). AWS 키 · 환경도 프로젝트에 한 번만 등록한다.
 */
const STORAGE_KEY = 'camellia.deployProjectId';
/** 저장된 프로젝트가 없을 때, 환경이 이미 등록된 프로젝트를 찾아보는 최근 프로젝트 개수 */
const RECENT_PROJECTS_TO_CHECK = 5;

export interface DeployProject { id: string; name: string }

type State =
  | { phase: 'loading' }
  | { phase: 'error'; error: unknown }
  | { phase: 'ready'; project: DeployProject | null; environments: EnvironmentSummary[] };

function readStoredId(): string | null { try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; } }
function storeId(id: string): void { try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* 저장하지 못해도 이번 화면에서는 동작한다 */ } }

async function findProject(): Promise<{ project: DeployProject | null; environments: EnvironmentSummary[] }> {
  const storedId = readStoredId();
  if (storedId) {
    const project = await getProject(storedId).catch(() => null);
    if (project) return { project, environments: await listEnvironments(project.id) };
  }
  // 다른 브라우저에서 등록해 둔 프로젝트가 있으면 이어서 쓴다.
  const recent = (await listProjects({ limit: 100 })).items.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, RECENT_PROJECTS_TO_CHECK);
  for (const project of recent) {
    const environments = await listEnvironments(project.id).catch(() => []);
    if (environments.some((environment) => environment.isDefault)) { storeId(project.id); return { project, environments }; }
  }
  return { project: null, environments: [] };
}

/** 고른 대상에 배포하려면 무엇이 더 필요한지. 온프레미스는 이미지를 사용자 AWS 계정의 ECR에 두므로 AWS 환경도 필요하다. */
export function missingFor(target: DeployTarget, environments: EnvironmentSummary[]): Array<'aws' | 'onprem'> {
  const has = (type: 'aws' | 'onprem') => environments.some((environment) => environment.type === type && environment.isDefault);
  const required: Array<'aws' | 'onprem'> = target === 'aws' ? ['aws'] : ['aws', 'onprem'];
  return required.filter((type) => !has(type));
}

export function useDeployProject() {
  const [state, setState] = useState<State>({ phase: 'loading' });

  const refresh = useCallback(async () => {
    try { setState({ phase: 'ready', ...(await findProject()) }); } catch (error) { setState({ phase: 'error', error }); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  /** AWS 키를 등록하거나 바꾼다. 프로젝트가 아직 없으면 먼저 만든다. */
  const registerAws = useCallback(async (input: { accessKeyId: string; secretAccessKey: string; region: string }, projectName: string) => {
    const current = state.phase === 'ready' ? state.project : null;
    const currentAws = state.phase === 'ready' ? state.environments.find((environment) => environment.type === 'aws' && environment.isDefault) ?? null : null;
    const project = current ?? await createProject(projectName);
    storeId(project.id);
    try {
      await registerAwsEnvironment(project.id, input, currentAws);
    } finally {
      await refresh();
    }
  }, [state, refresh]);

  return { state, refresh, registerAws };
}
