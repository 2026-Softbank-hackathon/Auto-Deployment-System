import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DeploymentApiError } from '../api/deployment-api';
import { ja } from './ja';
import { ko, type Messages } from './ko';

export type Language = 'ko' | 'ja';

const dictionaries: Record<Language, Messages> = { ko, ja };
const storageKey = 'camellia.language';

interface I18nContextValue { language: Language; setLanguage: (language: Language) => void; t: Messages }

const I18nContext = createContext<I18nContextValue>({ language: 'ko', setLanguage: () => {}, t: ko });

/** 처음 접속하면 한국어. 사용자가 바꾼 언어만 저장한다. */
function readPreference(): Language {
  try { return window.localStorage.getItem(storageKey) === 'ja' ? 'ja' : 'ko'; } catch { return 'ko'; }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readPreference);

  const setLanguage = useCallback((next: Language) => {
    setLanguageState(next);
    try { window.localStorage.setItem(storageKey, next); } catch { /* 저장 불가 환경에서는 이번 세션에만 적용 */ }
  }, []);

  // 스크린리더 발음과 언어별 폰트(:lang)를 위해 문서 언어도 함께 바꾼다.
  useEffect(() => { document.documentElement.lang = language; }, [language]);

  const value = useMemo(() => ({ language, setLanguage, t: dictionaries[language] }), [language, setLanguage]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue { return useContext(I18nContext); }

/**
 * 프론트가 만든 오류는 현재 언어로 바꾼다. 서버가 보낸 문구·응답 형식 오류 등은 원문 그대로 둔다.
 */
export function errorMessage(error: unknown, t: Messages, fallback: string): string {
  if (error instanceof DeploymentApiError) return t.errors.requestFailed(error.status);
  if (error instanceof TypeError) return t.errors.network;
  return error instanceof Error ? error.message : fallback;
}
