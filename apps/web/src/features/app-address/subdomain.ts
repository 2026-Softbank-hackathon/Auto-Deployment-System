import { useEffect, useState } from 'react';
import { checkSubdomain } from '../../api/deployment-api';

/**
 * 앱 주소 {subdomain}.{플랫폼 도메인} (#302). 규칙의 기준은 서버(packages/contracts subdomain.ts)이고,
 * 여기서는 입력하는 동안 바로 보여 줄 형식 검사와 이름 → 주소 추천만 한다. 예약어 · 사용 중은 서버에 묻는다.
 */
export const PLATFORM_DOMAIN = (import.meta.env.VITE_PLATFORM_DOMAIN as string | undefined)?.trim() || 'camellia-deploy.app';
export const SUBDOMAIN_MAX = 40;
const SUBDOMAIN_MIN = 3;
const FORMAT = /^[a-z0-9](?:[a-z0-9]|-(?!-))*[a-z0-9]$/;

export function subdomainFormatOk(value: string): boolean {
  return value.length >= SUBDOMAIN_MIN && value.length <= SUBDOMAIN_MAX && FORMAT.test(value);
}

/** 앱 이름으로 주소를 추천한다 (예: "Monolith_SeoHyeon" → "monolith-seohyeon"). 만들 수 없으면 빈 문자열 */
export function suggestSubdomain(name: string): string {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SUBDOMAIN_MAX)
    .replace(/-+$/g, '');
  return subdomainFormatOk(slug) ? slug : '';
}

export type SubdomainCheck =
  | { phase: 'empty' }
  | { phase: 'checking' }
  | { phase: 'available' }
  | { phase: 'current' }
  | { phase: 'format' | 'reserved' | 'taken' }
  | { phase: 'error' };

/** 입력이 멈추면(300ms) 서버에 사용 가능 여부를 묻는다. current 는 지금 이 앱의 주소(주소 변경 화면) */
export function useSubdomainCheck(value: string, current?: string | null): SubdomainCheck {
  const name = value.trim().toLowerCase();
  const local: SubdomainCheck | null = name === '' ? { phase: 'empty' }
    : current && name === current ? { phase: 'current' }
      : !subdomainFormatOk(name) ? { phase: 'format' } : null;
  const [remote, setRemote] = useState<{ name: string; check: SubdomainCheck } | null>(null);

  useEffect(() => {
    if (local) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      checkSubdomain(name, controller.signal).then(
        (result) => setRemote({ name, check: result.available ? { phase: 'available' } : { phase: result.reason ?? 'taken' } }),
        () => { if (!controller.signal.aborted) setRemote({ name, check: { phase: 'error' } }); },
      );
    }, 300);
    return () => { controller.abort(); window.clearTimeout(timer); };
    // local 은 name · current 로 정해진다
  }, [name, current]);

  if (local) return local;
  return remote && remote.name === name ? remote.check : { phase: 'checking' };
}
