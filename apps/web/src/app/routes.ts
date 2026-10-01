export type ProjectTab = 'deployments' | 'env' | 'settings';

export type Route =
  | { page: 'dashboard' }
  | { page: 'deploy' }
  | { page: 'setup' }
  | { page: 'projects' }
  | { page: 'project'; projectId: string; tab: ProjectTab }
  | { page: 'progress'; deploymentId: string }
  | { page: 'result'; deploymentId: string };

export function routeFromLocation(): Route {
  const match = window.location.pathname.match(/^\/deployments\/([^/]+)(?:\/(result))?\/?$/);
  if (match) return { page: match[2] ? 'result' : 'progress', deploymentId: decodeURIComponent(match[1]) };
  if (window.location.pathname === '/setup') return { page: 'setup' };
  if (window.location.pathname === '/projects') return { page: 'projects' };
  const project = window.location.pathname.match(/^\/projects\/([^/]+)(?:\/(env|settings))?\/?$/);
  if (project) return { page: 'project', projectId: decodeURIComponent(project[1]), tab: (project[2] as ProjectTab | undefined) ?? 'deployments' };
  return window.location.pathname === '/deploy' ? { page: 'deploy' } : { page: 'dashboard' };
}
