import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
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
  | { phase: 'ready'; /** 고를 수 있는 앱 전체 (최근 것부터) */ projects: DeployProject[]; project: DeployProject | null; environments: EnvironmentSummary[]; /** 저장된 시크릿 이름. 목록을 읽지 못했으면 null (모르는 상태로 두고 막지 않는다) */ secretNames: string[] | null };

function readStoredId(): string | null { try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; } }
function storeId(id: string): void { try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* 저장하지 못해도 이번 화면에서는 동작한다 */ } }

type Found = { projects: DeployProject[]; project: DeployProject | null; environments: EnvironmentSummary[]; secretNames: string[] | null };

async function withSecrets(projects: DeployProject[], project: DeployProject, environments: EnvironmentSummary[]): Promise<Found> {
  return { projects, project, environments, secretNames: await listSecretNames(project.id).catch(() => null) };
}

async function findProject(): Promise<Found> {
  const projects: DeployProject[] = (await listProjects({ limit: 100 })).items.sort((a, b) => Number(b.id) - Number(a.id)).map(({ id, name }) => ({ id, name }));
  const storedId = readStoredId();
  if (storedId) {
    const project = projects.find((candidate) => candidate.id === storedId) ?? await getProject(storedId).catch(() => null);
    if (project) return withSecrets(projects.some((candidate) => candidate.id === project.id) ? projects : [project, ...projects], project, await listEnvironments(project.id));
  }
  // 다른 브라우저에서 등록해 둔 프로젝트가 있으면 이어서 쓴다.
  for (const project of projects.slice(0, RECENT_PROJECTS_TO_CHECK)) {
    const environments = await listEnvironments(project.id).catch(() => []);
    if (environments.some((environment) => environment.isDefault)) { storeId(project.id); return withSecrets(projects, project, environments); }
  }
  // 연결된 앱이 없으면 가장 최근 앱을 쓴다 (연결 설정에서 이어서 등록할 수 있게).
  const latest = projects[0];
  if (latest) { storeId(latest.id); return withSecrets(projects, latest, await listEnvironments(latest.id).catch(() => [])); }
  return { projects, project: null, environments: [], secretNames: null };
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

function useDeployProjectState() {
  const [state, setState] = useState<State>({ phase: 'loading' });

  // 여러 화면이 동시에 다시 읽기를 부르므로, 늦게 도착한 예전 응답이 최신 상태(방금 바꾼 프로젝트)를 덮어쓰지 않게 한다.
  const latestRefresh = useRef(0);
  const refresh = useCallback(async () => {
    const turn = ++latestRefresh.current;
    try {
      const found = await findProject();
      if (turn === latestRefresh.current) setState({ phase: 'ready', ...found });
    } catch (error) {
      if (turn === latestRefresh.current) setState({ phase: 'error', error });
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  /** 앱 이름으로 프로젝트를 만들고 그 앱으로 바꾼다. 같은 이름이 있으면 서버가 409를 돌려준다. */
  const createDeployProject = useCallback(async (name: string) => {
    const project = await createProject(name);
    storeId(project.id);
    setState((current) => ({ phase: 'ready', projects: [project, ...(current.phase === 'ready' ? current.projects : [])], project, environments: [], secretNames: [] }));
  }, []);

  /** 배포할 앱을 바꾼다. 연결 상태(AWS 키 · 환경)도 그 앱의 것으로 다시 읽는다. */
  const selectProject = useCallback(async (projectId: string) => {
    storeId(projectId);
    await refresh();
  }, [refresh]);

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

  return { state, refresh, createDeployProject, selectProject, registerAws, registerOnprem };
}

type DeployProjectValue = ReturnType<typeof useDeployProjectState>;
const DeployProjectContext = createContext<DeployProjectValue | null>(null);

/** 사이드바 · 연결 설정 · 간단 배포가 같은 프로젝트 · 환경 상태를 보도록 앱 전체에 한 번만 둔다. */
export function DeployProjectProvider({ children }: { children: ReactNode }) {
  return createElement(DeployProjectContext.Provider, { value: useDeployProjectState() }, children);
}

export function useDeployProject(): DeployProjectValue {
  const value = useContext(DeployProjectContext);
  if (!value) throw new Error('useDeployProject must be used inside DeployProjectProvider');
  return value;
}

/** 화면이 쓰기 좋게 정리한 연결 상태. */
export function setupStatus(state: DeployProjectValue['state']) {
  if (state.phase !== 'ready') return { ready: false as const };
  const defaultOf = (type: EnvironmentSummary['type']) => state.environments.find((environment) => environment.type === type && environment.isDefault) ?? null;
  const aws = defaultOf('aws');
  const keysMissing = awsKeysMissing(state.environments, state.secretNames);
  return { ready: true as const, projects: state.projects, project: state.project, aws, onprem: defaultOf('onprem'), keysMissing, awsReady: aws !== null && !keysMissing };
}
