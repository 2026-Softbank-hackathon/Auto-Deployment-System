export type Route =
  | { page: 'dashboard' }
  | { page: 'deploy' }
  | { page: 'setup' }
  | { page: 'projects' }
  | { page: 'progress'; deploymentId: string }
  | { page: 'result'; deploymentId: string };

export function routeFromLocation(): Route {
  const match = window.location.pathname.match(/^\/deployments\/([^/]+)(?:\/(result))?\/?$/);
  if (match) return { page: match[2] ? 'result' : 'progress', deploymentId: decodeURIComponent(match[1]) };
  if (window.location.pathname === '/setup') return { page: 'setup' };
  if (window.location.pathname === '/projects') return { page: 'projects' };
  return window.location.pathname === '/deploy' ? { page: 'deploy' } : { page: 'dashboard' };
}
