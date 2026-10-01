export type ProjectTab = 'deployments' | 'env' | 'settings';

export type Route =
  | { page: 'dashboard' }
  | { page: 'deploy' }
  | { page: 'projects' }
  | { page: 'project'; projectId: string; tab: ProjectTab }
  | { page: 'progress'; deploymentId: string }
  | { page: 'result'; deploymentId: string };

export function routeFromLocation(): Route {
  const match = window.location.pathname.match(/^\/deployments\/([^/]+)(?:\/(result))?\/?$/);
  if (match) return { page: match[2] ? 'result' : 'progress', deploymentId: decodeURIComponent(match[1]) };
  // 예전 연결 설정 주소. 설정은 프로젝트 상세의 설정 탭으로 옮겼다.
  if (window.location.pathname === '/setup') return { page: 'projects' };
  if (window.location.pathname === '/projects') return { page: 'projects' };
  const project = window.location.pathname.match(/^\/projects\/([^/]+)(?:\/(env|settings))?\/?$/);
  if (project) return { page: 'project', projectId: decodeURIComponent(project[1]), tab: (project[2] as ProjectTab | undefined) ?? 'deployments' };
  return window.location.pathname === '/deploy' ? { page: 'deploy' } : { page: 'dashboard' };
}
