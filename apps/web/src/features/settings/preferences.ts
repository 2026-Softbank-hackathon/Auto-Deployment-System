import { createContext, createElement, useCallback, useContext, useState, type ReactNode } from 'react';
import { isDeployTarget, type DeployTarget } from '../deployment-start/TargetToggle';

/**
 * 이 브라우저에만 저장하는 사용자 설정. 서버에는 보내지 않는다(계정이 없어 기기 간에 공유되지 않는다).
 * 언어와 사운드는 각자의 Provider가 따로 기억한다.
 */
export interface Preferences {
  /** 배포가 끝났을 때 화면 오른쪽 아래 알림을 띄울지 */
  notify: boolean;
  /** 간단 배포를 열었을 때 골라져 있는 배포할 곳 */
  defaultTarget: DeployTarget;
  /** "배포 전에 감지한 포트 확인하기"를 기본으로 켜 둘지 */
  reviewFirst: boolean;
}

const STORAGE_KEY = 'camellia.preferences';
/** 처음 쓰는 사람의 기본값. 배포할 곳은 데모 환경 변수(VITE_DEMO_TARGET)를 따른다. */
const defaults: Preferences = {
  notify: true,
  defaultTarget: isDeployTarget(import.meta.env.VITE_DEMO_TARGET) ? import.meta.env.VITE_DEMO_TARGET : 'aws',
  reviewFirst: false,
};

function read(): Preferences {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Record<keyof Preferences, unknown>> | null;
    if (!stored || typeof stored !== 'object') return defaults;
    return {
      notify: typeof stored.notify === 'boolean' ? stored.notify : defaults.notify,
      defaultTarget: isDeployTarget(stored.defaultTarget) ? stored.defaultTarget : defaults.defaultTarget,
      reviewFirst: typeof stored.reviewFirst === 'boolean' ? stored.reviewFirst : defaults.reviewFirst,
    };
  } catch { return defaults; }
}

interface PreferencesValue { preferences: Preferences; update: (patch: Partial<Preferences>) => void }
const PreferencesContext = createContext<PreferencesValue>({ preferences: defaults, update: () => {} });

export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(read);
  const update = useCallback((patch: Partial<Preferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch };
      try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* 저장하지 못해도 이번 화면에서는 적용된다 */ }
      return next;
    });
  }, []);
  return createElement(PreferencesContext.Provider, { value: { preferences, update } }, children);
}

export function usePreferences(): PreferencesValue { return useContext(PreferencesContext); }
