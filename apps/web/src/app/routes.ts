export type Route =
  | { page: 'dashboard' }
  | { page: 'deploy' }
  | { page: 'progress'; deploymentId: string }
  | { page: 'result'; deploymentId: string };

export function routeFromLocation(): Route {
  const match = window.location.pathname.match(/^\/deployments\/([^/]+)(?:\/(result))?\/?$/);
  if (match) return { page: match[2] ? 'result' : 'progress', deploymentId: decodeURIComponent(match[1]) };
  return window.location.pathname === '/deploy' ? { page: 'deploy' } : { page: 'dashboard' };
}
