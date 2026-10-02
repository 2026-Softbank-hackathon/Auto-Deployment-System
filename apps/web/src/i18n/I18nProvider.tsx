import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { DeploymentApiError } from '../api/deployment-api';
import { ja } from './ja';
import { ko, type Messages } from './ko';
import { preloadLanguageFonts, runLanguageTransition } from './language-transition';

export type Language = 'ko' | 'ja';

const dictionaries: Record<Language, Messages> = { ko, ja };
const storageKey = 'camellia.language';

interface I18nContextValue {
  language: Language;
  /** 방금 고른 언어. 글꼴을 받는 동안에도 토글이 바로 반응하도록 language보다 먼저 바뀐다. */
  selectedLanguage: Language;
  setLanguage: (language: Language) => void;
  t: Messages;
}

const I18nContext = createContext<I18nContextValue>({ language: 'ko', selectedLanguage: 'ko', setLanguage: () => {}, t: ko });

/** 처음 접속하면 한국어. 사용자가 바꾼 언어만 저장한다. */
function readPreference(): Language {
  try { return window.localStorage.getItem(storageKey) === 'ja' ? 'ja' : 'ko'; } catch { return 'ko'; }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(readPreference);
  const [selectedLanguage, setSelectedLanguage] = useState<Language>(language);
  const requested = useRef<Language>(language);

  // 글꼴은 글자 범위별 조각으로 나뉘어 있어서, 처음 보는 글자가 나오는 화면으로 옮기면 그때 조각을 받느라 글자가 한 번 바뀐다.
  // 첫 화면이 뜬 뒤 한가할 때 현재 언어의 화면 문구에 쓰이는 조각을 미리 받아 두어, 화면을 옮길 때 깜빡이지 않게 한다.
  useEffect(() => {
    const warm = () => { void preloadLanguageFonts(requested.current, dictionaries[requested.current]); };
    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(warm, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(warm, 1200);
    return () => clearTimeout(timer);
  }, []);

  /** 글꼴을 먼저 받아 두고, 화면 전체를 교차 전환하면서 언어를 바꾼다. */
  const setLanguage = useCallback((next: Language) => {
    if (next === requested.current) return;
    requested.current = next;
    setSelectedLanguage(next);
    try { window.localStorage.setItem(storageKey, next); } catch { /* 저장 불가 환경에서는 이번 세션에만 적용 */ }
    void preloadLanguageFonts(next, dictionaries[next]).then(() => {
      if (requested.current !== next) return; // 기다리는 사이 다른 언어를 눌렀으면 그쪽만 반영
      runLanguageTransition(() => {
        // 전환 스냅샷이 새 언어 화면을 찍도록 DOM과 문서 언어를 동기로 바꾼다.
        flushSync(() => setLanguageState(next));
        document.documentElement.lang = next;
      });
    });
  }, []);

  // 스크린리더 발음과 언어별 폰트(:lang)를 위해 문서 언어도 함께 바꾼다.
  useEffect(() => { document.documentElement.lang = language; }, [language]);

  const value = useMemo(() => ({ language, selectedLanguage, setLanguage, t: dictionaries[language] }), [language, selectedLanguage, setLanguage]);
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

/** 서버가 거절한 사유. 서버가 준 설명이 있으면 그대로, 없으면 현재 언어의 일반 문구. */
export function serverReasonText(error: unknown, t: Messages, fallback: string): string {
  return error instanceof DeploymentApiError && error.serverMessage ? error.serverMessage : errorMessage(error, t, fallback);
}

/** 재배포(다른 환경으로 배포 · 롤백 포함)를 서버가 거절한 사유. 아는 오류 코드는 현재 언어 문구로, 모르는 코드는 서버 설명 그대로. */
export function redeployReasonText(error: unknown, t: Messages, fallback: string): string {
  const known = error instanceof DeploymentApiError && error.code ? t.redeploy.errors[error.code] : undefined;
  return known ?? serverReasonText(error, t, fallback);
}
