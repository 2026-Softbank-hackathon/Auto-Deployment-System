export type ProjectTab = 'deployments' | 'env' | 'settings';

/** 배포 화면의 탭. auto는 주소에 탭이 없을 때(/deployments/:id) — 실패한 배포면 실패 원인, 아니면 진행을 보여 준다. */
export type DeploymentTab = 'auto' | 'progress' | 'failure' | 'logs' | 'analysis';

export type Route =
  | { page: 'dashboard' }
  | { page: 'deploy' }
  | { page: 'connections' }
  | { page: 'ops' }
  | { page: 'project'; projectId: string; tab: ProjectTab }
  | { page: 'progress'; deploymentId: string; tab: DeploymentTab }
  | { page: 'result'; deploymentId: string };

export function routeFromLocation(): Route {
  const match = window.location.pathname.match(/^\/deployments\/([^/]+)(?:\/(result|progress|failure|logs|analysis))?\/?$/);
  if (match) {
    const deploymentId = decodeURIComponent(match[1]);
    return match[2] === 'result' ? { page: 'result', deploymentId } : { page: 'progress', deploymentId, tab: (match[2] as DeploymentTab | undefined) ?? 'auto' };
  }
  // 예전 주소. 연결 설정은 연결 화면으로 (#218), 내 프로젝트 목록은 대시보드로 합쳤다 (#219).
  if (window.location.pathname === '/connections' || window.location.pathname === '/setup') return { page: 'connections' };
  if (window.location.pathname === '/projects') return { page: 'dashboard' };
  // 플랫폼 운영 화면 (#308)
  if (/^\/ops\/?$/.test(window.location.pathname)) return { page: 'ops' };
  const project = window.location.pathname.match(/^\/projects\/([^/]+)(?:\/(env|settings))?\/?$/);
  if (project) return { page: 'project', projectId: decodeURIComponent(project[1]), tab: (project[2] as ProjectTab | undefined) ?? 'deployments' };
  return window.location.pathname === '/deploy' ? { page: 'deploy' } : { page: 'dashboard' };
}
