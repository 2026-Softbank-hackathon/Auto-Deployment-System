import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createProject, getProject, listEnvironments, listProjects, type EnvironmentSummary } from '../../api/deployment-api';

/**
 * 지금 보고 있는 앱(프로젝트)과 그 앱에만 묶인 예전 방식의 연결. 프로젝트 상세가 쓴다.
 * 연결은 이제 공용 연결(연결 화면)로 한 번만 등록한다 (#218). 앱마다 연결을 등록하지 않는다.
 */
const STORAGE_KEY = 'camellia.deployProjectId';

export interface DeployProject { id: string; name: string }

type State =
  | { phase: 'loading' }
  | { phase: 'error'; error: unknown }
  | { phase: 'ready'; /** 앱 전체 (최근 것부터) */ projects: DeployProject[]; project: DeployProject | null; /** 고른 앱에만 묶인 연결 (공용 연결은 없음) */ environments: EnvironmentSummary[] };

function readStoredId(): string | null { try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; } }
function storeId(id: string): void { try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* 저장하지 못해도 이번 화면에서는 동작한다 */ } }

type Found = { projects: DeployProject[]; project: DeployProject | null; environments: EnvironmentSummary[] };

async function findProject(): Promise<Found> {
  const projects: DeployProject[] = (await listProjects({ limit: 100 })).items.sort((a, b) => Number(b.id) - Number(a.id)).map(({ id, name }) => ({ id, name }));
  const storedId = readStoredId();
  const project = storedId ? projects.find((candidate) => candidate.id === storedId) ?? await getProject(storedId).catch(() => null) : null;
  if (!project) return { projects, project: null, environments: [] };
  return {
    projects: projects.some((candidate) => candidate.id === project.id) ? projects : [project, ...projects],
    project,
    environments: await listEnvironments(project.id).catch(() => []),
  };
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

  /**
   * 앱 이름으로 프로젝트를 만들고 그 앱으로 바꾼다. 같은 이름이 있으면 서버가 409를 돌려준다.
   * subdomain 을 주면 그 주소로 만든다 (#302). 다른 앱이 쓰는 주소면 409 SUBDOMAIN_TAKEN.
   */
  const createDeployProject = useCallback(async (name: string, subdomain?: string) => {
    const project = await createProject(name, subdomain);
    storeId(project.id);
    setState((current) => ({ phase: 'ready', projects: [project, ...(current.phase === 'ready' ? current.projects : [])], project, environments: [] }));
    return project;
  }, []);

  /** 보고 있는 앱을 바꾼다. 그 앱에만 묶인 연결도 다시 읽는다. */
  const selectProject = useCallback(async (projectId: string) => {
    storeId(projectId);
    await refresh();
  }, [refresh]);

  return { state, refresh, createDeployProject, selectProject };
}

type DeployProjectValue = ReturnType<typeof useDeployProjectState>;
const DeployProjectContext = createContext<DeployProjectValue | null>(null);

/** 프로젝트 상세 · 간단 배포가 같은 앱 목록을 보도록 앱 전체에 한 번만 둔다. */
export function DeployProjectProvider({ children }: { children: ReactNode }) {
  return createElement(DeployProjectContext.Provider, { value: useDeployProjectState() }, children);
}

export function useDeployProject(): DeployProjectValue {
  const value = useContext(DeployProjectContext);
  if (!value) throw new Error('useDeployProject must be used inside DeployProjectProvider');
  return value;
}
