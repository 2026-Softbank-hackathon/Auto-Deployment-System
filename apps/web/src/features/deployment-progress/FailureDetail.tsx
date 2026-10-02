import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n/I18nProvider';

function CopyIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15 V6 a2 2 0 0 1 2 -2 H15" />
  </svg>;
}
function CheckIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12.5 L10 17.5 L19 7" />
  </svg>;
}

/**
 * 서버가 실패 코드와 함께 준 상세 원문 (예: Terraform 오류 출력). 길고 영어 로그일 수 있어 기본은 접어 둔다.
 * 실패 안내 영역의 폭 안에서 줄바꿈해 보여 주고(긴 줄이 화면 밖으로 나가지 않게), 흰 상자로 구분한다.
 * 팀에 문의할 때 그대로 붙여 넣을 수 있게 복사 버튼을 둔다. 원문은 고치지 않는다.
 */
export function FailureDetail({ detail }: { detail: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  // "복사했어요" 표시는 잠깐만 보여 주고 되돌린다.
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try { await navigator.clipboard.writeText(detail); setCopied(true); } catch { setCopied(false); }
  }
  return <details className="failure-detail">
    <summary>{t.run.failureDetailToggle}</summary>
    <div className="failure-detail__box">
      <div className="failure-detail__bar">
        <span>{t.run.failureDetailLabel}</span>
        <button type="button" className={`failure-detail__copy ${copied ? 'is-copied' : ''}`} onClick={() => void copy()}>
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span aria-live="polite">{copied ? t.setup.copied : t.setup.copy}</span>
        </button>
      </div>
      <pre tabIndex={0} aria-label={t.run.failureDetailLabel}>{detail}</pre>
    </div>
  </details>;
}
