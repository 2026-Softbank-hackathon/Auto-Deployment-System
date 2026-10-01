import { useCallback, useEffect, useState } from 'react';
import { createOnpremEnvironment, createProject, getProject, listEnvironments, listProjects, listSecretNames, registerAwsEnvironment, type EnvironmentSummary } from '../../api/deployment-api';
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
  | { phase: 'ready'; project: DeployProject | null; environments: EnvironmentSummary[]; /** 저장된 시크릿 이름. 목록을 읽지 못했으면 null (모르는 상태로 두고 막지 않는다) */ secretNames: string[] | null };

function readStoredId(): string | null { try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; } }
function storeId(id: string): void { try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* 저장하지 못해도 이번 화면에서는 동작한다 */ } }

type Found = { project: DeployProject | null; environments: EnvironmentSummary[]; secretNames: string[] | null };

async function withSecrets(project: DeployProject, environments: EnvironmentSummary[]): Promise<Found> {
  return { project, environments, secretNames: await listSecretNames(project.id).catch(() => null) };
}

async function findProject(): Promise<Found> {
  const storedId = readStoredId();
  if (storedId) {
    const project = await getProject(storedId).catch(() => null);
    if (project) return withSecrets(project, await listEnvironments(project.id));
  }
  // 다른 브라우저에서 등록해 둔 프로젝트가 있으면 이어서 쓴다.
  const recent = (await listProjects({ limit: 100 })).items.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, RECENT_PROJECTS_TO_CHECK);
  for (const project of recent) {
    const environments = await listEnvironments(project.id).catch(() => []);
    if (environments.some((environment) => environment.isDefault)) { storeId(project.id); return withSecrets(project, environments); }
  }
  return { project: null, environments: [], secretNames: null };
}

/** 고른 대상에 배포하려면 무엇이 더 필요한지. 온프레미스는 이미지를 사용자 AWS 계정의 ECR에 두므로 AWS 환경도 필요하다. */
export function missingFor(target: DeployTarget, environments: EnvironmentSummary[]): Array<'aws' | 'onprem'> {
  const has = (type: 'aws' | 'onprem') => environments.some((environment) => environment.type === type && environment.isDefault);
  const required: Array<'aws' | 'onprem'> = target === 'aws' ? ['aws'] : ['aws', 'onprem'];
  return required.filter((type) => !has(type));
}

/**
 * 기본 AWS 환경은 있는데 그 환경이 참조하는 시크릿이 저장소에 없는 상태인지.
 * 서버는 아직 이 경우를 배포 생성에서 걸러 주지 않아서(빌드 단계에서야 실패한다) 화면에서 먼저 막는다.
 */
export function awsKeysMissing(environments: EnvironmentSummary[], secretNames: string[] | null): boolean {
  if (secretNames === null) return false;
  const aws = environments.find((environment) => environment.type === 'aws' && environment.isDefault);
  return aws !== undefined && aws.secretNames.some((name) => !secretNames.includes(name));
}

export function useDeployProject() {
  const [state, setState] = useState<State>({ phase: 'loading' });

  const refresh = useCallback(async () => {
    try { setState({ phase: 'ready', ...(await findProject()) }); } catch (error) { setState({ phase: 'error', error }); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  /** 처음 설정 1단계 — 앱 이름으로 프로젝트를 만든다. 같은 이름이 있으면 서버가 409를 돌려준다. */
  const createDeployProject = useCallback(async (name: string) => {
    const project = await createProject(name);
    storeId(project.id);
    setState({ phase: 'ready', project, environments: [], secretNames: [] });
  }, []);

  /** AWS 키를 등록하거나 바꾼다. 프로젝트가 먼저 있어야 한다. */
  const registerAws = useCallback(async (input: { accessKeyId: string; secretAccessKey: string; region: string }) => {
    if (state.phase !== 'ready' || !state.project) throw new Error('project is not ready');
    const currentAws = state.environments.find((environment) => environment.type === 'aws' && environment.isDefault) ?? null;
    try {
      await registerAwsEnvironment(state.project.id, input, currentAws);
    } finally {
      await refresh();
    }
  }, [state, refresh]);

  /** 온프레미스 환경을 호스트 이름으로 등록한다. 프로젝트가 먼저 있어야 한다. */
  const registerOnprem = useCallback(async (hostname: string) => {
    if (state.phase !== 'ready' || !state.project) throw new Error('project is not ready');
    try {
      return await createOnpremEnvironment(state.project.id, hostname);
    } finally {
      await refresh();
    }
  }, [state, refresh]);

  return { state, refresh, createDeployProject, registerAws, registerOnprem };
}
