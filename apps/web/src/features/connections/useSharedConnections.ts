import { useCallback, useEffect, useState } from 'react';
import { listSharedEnvironments, type EnvironmentSummary } from '../../api/deployment-api';
import { readCache, writeCache } from '../../lib/page-cache';

const CACHE_KEY = 'shared-connections';
/** Agent 온라인 여부를 다시 확인하는 간격. 서버는 90초 안에 연락이 있으면 온라인으로 본다. */
const POLL_MS = 10_000;

type State =
  | { phase: 'loading' }
  | { phase: 'error'; error: unknown }
  | { phase: 'ready'; connections: EnvironmentSummary[]; loadedAt: number };

/**
 * 공용 연결 목록 (#215). 연결 화면과 간단 배포가 같이 쓴다.
 * 화면이 열려 있는 동안 주기적으로 다시 읽어 Agent 온라인 여부를 맞춘다 (탭이 보이지 않을 때는 건너뛴다).
 */
export function useSharedConnections() {
  const [state, setState] = useState<State>(() => {
    const cached = readCache<{ connections: EnvironmentSummary[]; loadedAt: number }>(CACHE_KEY);
    return cached ? { phase: 'ready', ...cached } : { phase: 'loading' };
  });

  const refresh = useCallback(async () => {
    try {
      const next = { connections: await listSharedEnvironments(), loadedAt: Date.now() };
      writeCache(CACHE_KEY, next);
      setState({ phase: 'ready', ...next });
    } catch (error) {
      // 이미 목록을 보여 주고 있으면 잠깐의 실패로 화면을 비우지 않는다.
      setState((current) => (current.phase === 'ready' ? current : { phase: 'error', error }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const retry = useCallback(() => { setState({ phase: 'loading' }); void refresh(); }, [refresh]);

  return { state, refresh, retry };
}
