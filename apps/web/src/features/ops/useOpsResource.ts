import { useCallback, useEffect, useRef, useState } from 'react';

/** 운영 화면 자동 새로 고침 간격 */
export const OPS_REFRESH_MS = 10_000;

export interface OpsResource<T> {
  /** 마지막으로 받은 값 (새로 고침이 실패해도 그대로 둔다) */
  data: T | null;
  /** 마지막 요청의 오류. 성공하면 null */
  error: unknown;
  loading: boolean;
  retry: () => void;
}

/**
 * 카드 하나의 데이터를 10초마다 다시 받는다. 탭이 보이지 않으면 멈추고, 다시 보이면 바로 한 번 받은 뒤 이어 간다.
 * 카드마다 따로 부르므로 한 API 가 실패해도 다른 카드는 그대로 보인다.
 */
export function useOpsResource<T>(fetcher: () => Promise<T>): OpsResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const inFlight = useRef(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await fetcherRef.current();
      if (!alive.current) return;
      setData(next);
      setError(null);
    } catch (requestError) {
      if (alive.current) setError(requestError);
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    let timer: number | undefined;
    const start = () => {
      window.clearInterval(timer);
      void load();
      timer = window.setInterval(() => void load(), OPS_REFRESH_MS);
    };
    const onVisibility = () => {
      if (document.hidden) window.clearInterval(timer);
      else start();
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  const retry = useCallback(() => { setLoading(true); void load(); }, [load]);
  return { data, error, loading, retry };
}
