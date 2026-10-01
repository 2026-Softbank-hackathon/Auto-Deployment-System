import { useState } from 'react';
import { Keycap } from '../../components/ui/Keycap';
import { useI18n } from '../../i18n/I18nProvider';

/** 서버에서 실행할 명령. 긴 줄은 가로로 스크롤되고, 복사 버튼으로 그대로 가져갈 수 있다. */
export function CommandBlock({ command, label }: { command: string; label: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(command); setCopied(true); } catch { setCopied(false); }
  }
  return <div className="command-block">
    <pre tabIndex={0} aria-label={label}>{command}</pre>
    <Keycap variant="ghost" onClick={() => void copy()}>{copied ? t.setup.copied : t.setup.copy}</Keycap>
  </div>;
}
