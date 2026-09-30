import type { CSSProperties } from 'react';
import { useI18n, type Language } from '../../i18n/I18nProvider';

const options: ReadonlyArray<{ value: Language; label: string }> = [
  { value: 'ko', label: '한국어' },
  { value: 'ja', label: '日本語' },
];

/** 헤더 오른쪽 언어 선택. 각 버튼의 이름은 그 언어 자체로 표기하고 lang을 붙여 올바르게 읽히게 한다. */
export function LanguageToggle() {
  const { selectedLanguage, setLanguage, t } = useI18n();
  const index = Math.max(0, options.findIndex((option) => option.value === selectedLanguage));
  return <div className="language-toggle" role="group" aria-label={t.header.language} style={{ '--selected': index } as CSSProperties}>
    <span className="language-toggle__thumb" aria-hidden="true" />
    {options.map((option) => <button key={option.value} type="button" lang={option.value}
      className="language-toggle__option" aria-pressed={selectedLanguage === option.value}
      onClick={() => setLanguage(option.value)}>{option.label}</button>)}
  </div>;
}
