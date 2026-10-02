import { useState } from 'react';
import { Keycap } from '../../components/ui/Keycap';
import { useI18n } from '../../i18n/I18nProvider';

/**
 * 서버가 실패 코드와 함께 준 상세 원문 (예: Terraform 오류 출력). 길고 영어 로그일 수 있어 기본은 접어 둔다.
 * 팀에 문의할 때 그대로 붙여 넣을 수 있게 복사 버튼을 둔다. 원문은 고치지 않고 보여 준다.
 */
export function FailureDetail({ detail }: { detail: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(detail); setCopied(true); } catch { setCopied(false); }
  }
  return <details className="technical-details run-failure__detail">
    <summary>{t.run.failureDetailToggle}</summary>
    <pre tabIndex={0} aria-label={t.run.failureDetailToggle}>{detail}</pre>
    <Keycap variant="ghost" onClick={() => void copy()}>{copied ? t.setup.copied : t.setup.copy}</Keycap>
  </details>;
}
