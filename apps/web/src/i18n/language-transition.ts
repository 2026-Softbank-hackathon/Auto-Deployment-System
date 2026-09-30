import type { Language } from './I18nProvider';
import type { Messages } from './ko';

/** 언어별로 화면에 쓰는 글꼴 (tokens.css의 --font-display · --font-body와 같아야 한다). */
const languageFonts: Record<Language, string[]> = {
  ko: ['400 16px "Noto Sans KR Variable"', '700 16px "Noto Sans KR Variable"', '400 16px "Jua"'],
  ja: ['400 16px "Noto Sans JP Variable"', '700 16px "Noto Sans JP Variable"', '700 16px "M PLUS Rounded 1c"'],
};

const FONT_WAIT_LIMIT_MS = 400;

/** 사전의 모든 문구에서 글자를 모은다. unicode-range로 쪼개진 폰트 파일 중 실제로 필요한 것만 받기 위해서다. */
function collectText(value: unknown, into: Set<string>): Set<string> {
  if (typeof value === 'string') for (const char of value) into.add(char);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectText(item, into);
  return into;
}

/**
 * 바꿀 언어의 글꼴을 미리 받아 둔다. 전환 직후 대체 글꼴로 보였다가 바뀌는 깜빡임(FOUT)을 막는다.
 * 네트워크가 느려도 전환이 멈추지 않도록 최대 FONT_WAIT_LIMIT_MS만 기다린다.
 */
export async function preloadLanguageFonts(language: Language, messages: Messages): Promise<void> {
  if (!('fonts' in document)) return;
  const sample = [...collectText(messages, new Set('0123456789'))].join('');
  const loads = Promise.allSettled(languageFonts[language].map((font) => document.fonts.load(font, sample)));
  await Promise.race([loads, new Promise((resolve) => window.setTimeout(resolve, FONT_WAIT_LIMIT_MS))]);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * 화면 전체를 교차 전환(View Transitions API)하며 update를 실행한다.
 * 지원하지 않는 브라우저나 "동작 줄이기" 설정에서는 애니메이션 없이 바로 실행한다.
 */
export function runLanguageTransition(update: () => void): void {
  if (prefersReducedMotion() || typeof document.startViewTransition !== 'function') {
    update();
    return;
  }
  document.startViewTransition(update);
}
