import { useId } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { PLATFORM_DOMAIN, SUBDOMAIN_MAX, type SubdomainCheck } from './subdomain';

/**
 * 앱 주소 입력칸 (#302): [입력].camellia-deploy.app 과 바로 아래 확인 결과(사용 가능 · 이미 사용 중 · 형식 오류 …).
 * 간단 배포의 새 앱과 앱 설정의 주소 변경이 같이 쓴다.
 */
export function AddressField({ value, onChange, check, disabled, label, emptyHint, unavailableHint }: {
  value: string;
  onChange: (next: string) => void;
  check: SubdomainCheck;
  disabled?: boolean;
  label: string;
  /** 비어 있을 때 안내 */
  emptyHint: string;
  /** 쓸 수 없는 주소일 때 덧붙이는 안내 (예: 기본 주소로 만든다) */
  unavailableHint?: string;
}) {
  const { t } = useI18n();
  const copy = t.address;
  const id = useId();
  const unavailable = check.phase === 'format' || check.phase === 'reserved' || check.phase === 'taken' || check.phase === 'error';
  const message = check.phase === 'empty' ? emptyHint
    : check.phase === 'checking' ? copy.checking
      : check.phase === 'available' ? copy.available
        : check.phase === 'current' ? copy.current
          : check.phase === 'error' ? copy.checkFailed
            : copy[check.phase];

  return <div className="address-field">
    <label htmlFor={id}>{label}</label>
    <div className="address-field__input">
      <input id={id} value={value} onChange={(event) => onChange(event.target.value)} maxLength={SUBDOMAIN_MAX}
        autoComplete="off" spellCheck={false} autoCapitalize="none" disabled={disabled} aria-describedby={`${id}-status`}
        aria-invalid={unavailable || undefined} placeholder={copy.placeholder} />
      <span className="address-field__suffix" aria-hidden="true">.{PLATFORM_DOMAIN}</span>
    </div>
    <p id={`${id}-status`} className={`app-chooser__hint address-field__status ${check.phase === 'available' ? 'is-ok' : unavailable ? 'is-missing' : ''}`}
      aria-live="polite">
      {message}{unavailable && unavailableHint ? ` ${unavailableHint}` : ''}
    </p>
  </div>;
}
