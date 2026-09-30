import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { playCue, type SoundName } from './sound-engine';

const storageKey = 'camellia.sound';

interface SoundContextValue { enabled: boolean; setEnabled: (enabled: boolean) => void; play: (name: SoundName) => void }

const SoundContext = createContext<SoundContextValue>({ enabled: false, setEnabled: () => {}, play: () => {} });

function readPreference(): boolean {
  try { return window.localStorage.getItem(storageKey) !== 'off'; } catch { return true; }
}

export function SoundProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(readPreference);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try { window.localStorage.setItem(storageKey, next ? 'on' : 'off'); } catch { /* 저장 불가 환경에서는 이번 세션에만 적용 */ }
    if (next) playCue('toggle');
  }, []);

  const play = useCallback((name: SoundName) => { if (enabled) playCue(name); }, [enabled]);

  const value = useMemo(() => ({ enabled, setEnabled, play }), [enabled, setEnabled, play]);
  return <SoundContext.Provider value={value}>{children}</SoundContext.Provider>;
}

export function useSound(): SoundContextValue { return useContext(SoundContext); }
