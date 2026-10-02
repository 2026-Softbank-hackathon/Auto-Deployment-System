import { useId } from 'react';
import type { EnvironmentSummary } from '../../api/deployment-api';
import { followAppLink, type Navigate } from '../../app/navigation';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { AgentState } from '../connections/AgentState';

export interface ConnectionOption {
  connection: EnvironmentSummary;
  /** 고를 수 없는 이유. 고를 수 있으면 null */
  disabledReason: string | null;
}

/**
 * 간단 배포의 "배포할 연결" 칸: 공용 연결과 (고른 앱에 있으면) 그 앱에만 묶인 예전 연결을 카드로 보여 주고 하나를 고른다.
 * 오프라인인 온프레미스 서버처럼 지금 배포할 수 없는 연결은 이유와 함께 막아 둔다.
 */
export function ConnectionPicker({ options, loadError, onRetry, selectedId, onSelect, now, disabled, onNavigate }: {
  /** 읽는 중이면 null */
  options: ConnectionOption[] | null; loadError: unknown; onRetry: () => void;
  selectedId: string | null; onSelect: (id: string) => void; now: number; disabled?: boolean; onNavigate: Navigate;
}) {
  const { t } = useI18n();
  const copy = t.deploy.connection;
  const titleId = useId();
  const radioName = useId();
  const manage = <a className="setup-summary__link" href="/connections" onClick={(event) => followAppLink(event, onNavigate)}>{copy.manage}</a>;

  return <section className="connection-picker" aria-labelledby={titleId}>
    <div className="connection-picker__head">
      <h2 id={titleId}>{copy.label}</h2>
      {options !== null && options.length > 0 && manage}
    </div>
    {loadError !== null && options === null && <div className="notice error" role="alert"><strong>{copy.loadError}</strong><br />{errorMessage(loadError, t, copy.loadError)}
      <div><Keycap variant="ghost" onClick={onRetry}>{t.dashboard.retry}</Keycap></div></div>}
    {loadError === null && options === null && <p className="app-chooser__hint" role="status">{copy.loading}</p>}
    {options !== null && options.length === 0 && <p className="connection-picker__empty">{copy.empty}</p>}
    {options !== null && options.length > 0 && <div className="connection-options" role="radiogroup" aria-labelledby={titleId}>
      {options.map(({ connection, disabledReason }) => {
        const blocked = disabled || disabledReason !== null;
        const reasonId = `${radioName}-${connection.id}-reason`;
        return <label key={connection.id} className={`connection-option ${disabledReason ? 'is-disabled' : ''}`}>
          <input type="radio" name={radioName} value={connection.id} checked={selectedId === connection.id} disabled={blocked}
            onChange={() => onSelect(connection.id)} aria-describedby={disabledReason ? reasonId : undefined} />
          <span className="connection-option__type">{t.deploy.targets[connection.type]}</span>
          <strong className="connection-option__name">{connection.type === 'aws' ? connection.region ?? connection.name : connection.hostname ?? connection.name}</strong>
          {/* 같은 리전에 AWS 계정이 여럿이면 연결 이름(키 끝 네 자리)으로 구분한다. */}
          {connection.type === 'aws' && connection.region && <span className="connection-option__sub">{connection.name}</span>}
          <span className="connection-option__meta">
            {connection.type === 'onprem' && <AgentState connection={connection} now={now} />}
            {!connection.shared && <span className="connection-badge">{copy.appOnly}</span>}
          </span>
          {disabledReason && <span id={reasonId} className="connection-option__reason">{disabledReason}</span>}
        </label>;
      })}
    </div>}
  </section>;
}
