import { deploymentEventsUrl } from './deployment-api';

/** packages/contracts/src/events.ts 의 DEPLOYMENT_EVENT_NAMES와 같은 목록 (백엔드가 실제로 보내는 이벤트). */
export const deploymentEventNames = ['state_changed', 'analysis.progress', 'approval_requested', 'log.line', 'ir_updated', 'missing_resources_updated'] as const;
export type DeploymentEventName = typeof deploymentEventNames[number];
export interface DeploymentEvent { name: DeploymentEventName; payload: unknown; receivedAt: Date; }

function parsePayload(data: string): unknown {
  try { return JSON.parse(data) as unknown; } catch { return data; }
}

/** API-07 transport boundary. Event payload interpretation stays outside UI components. */
export function subscribeToDeploymentEvents(deploymentId: string, onEvent: (event: DeploymentEvent) => void, onError: () => void): () => void {
  const source = new EventSource(deploymentEventsUrl(deploymentId), { withCredentials: true });
  const listeners = deploymentEventNames.map((name) => {
    const listener = (event: Event) => {
      const message = event as MessageEvent<string>;
      onEvent({ name, payload: parsePayload(message.data), receivedAt: new Date() });
    };
    source.addEventListener(name, listener);
    return { name, listener };
  });
  source.onerror = onError;
  return () => { listeners.forEach(({ name, listener }) => source.removeEventListener(name, listener)); source.close(); };
}
