import { useState } from 'react';
import {
  deleteEnvironment, deleteSharedSecret, DeploymentApiError, setDefaultEnvironment,
  type AgentRegistrationToken, type EnvironmentSummary,
} from '../api/deployment-api';
import { Keycap } from '../components/ui/Keycap';
import { Koro } from '../components/ui/Koro';
import { StatusTape } from '../components/ui/StatusTape';
import { AddConnectionDialog } from '../features/connections/AddConnectionDialog';
import { AgentInstallSteps } from '../features/connections/AgentInstallSteps';
import { AgentState } from '../features/connections/AgentState';
import { useSharedConnections } from '../features/connections/useSharedConnections';
import { EnvironmentIcon } from '../features/dashboard/DeploymentRow';
import { errorMessage, useI18n } from '../i18n/I18nProvider';

const COLUMNS = 5;

/** 삭제 확인. 브라우저 확인 창 대신 줄 바로 아래에서 한 번 더 묻는다. */
function RemoveConfirm({ connection, others, onRemoved, onCancel }: { connection: EnvironmentSummary; /** 남는 공용 연결 (키를 같이 쓰는지 확인용) */ others: EnvironmentSummary[]; onRemoved: () => Promise<void>; onCancel: () => void }) {
  const { t } = useI18n();
  const copy = t.connections;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await deleteEnvironment(connection.id);
    } catch (requestError) {
      setError(requestError);
      setBusy(false);
      return;
    }
    // 연결이 지워졌으면 그 연결만 쓰던 키도 치운다. 실패해도 연결 삭제는 끝난 것이라 알리지 않는다.
    const stillUsed = new Set(others.flatMap((other) => other.secretNames));
    await Promise.allSettled(connection.secretNames.filter((name) => !stillUsed.has(name)).map((name) => deleteSharedSecret(name)));
    await onRemoved();
  }

  return <div className="connection-confirm" role="group" aria-label={copy.remove}>
    <p>{copy.removeConfirm(connection.hostname ?? connection.name)}</p>
    {error !== null && <p className="connection-confirm__error" role="alert">
      {error instanceof DeploymentApiError && error.status === 409 ? copy.removeInUse : `${copy.removeError} ${errorMessage(error, t, copy.removeError)}`}
    </p>}
    <div className="aws-key-form__actions">
      <Keycap variant="secondary" disabled={busy} onClick={() => void remove()}>{busy ? copy.removing : copy.removeYes}</Keycap>
      <Keycap variant="ghost" disabled={busy} onClick={onCancel}>{copy.cancel}</Keycap>
    </div>
  </div>;
}

/** 표의 한 줄. 설치 안내와 삭제 확인은 줄 바로 아래 칸에 펼친다. */
function ConnectionRow({ connection, others, now, freshToken, onRefresh }: {
  connection: EnvironmentSummary; others: EnvironmentSummary[]; now: number; freshToken: AgentRegistrationToken | null; onRefresh: () => Promise<void>;
}) {
  const { t } = useI18n();
  const copy = t.connections;
  const cols = copy.columns;
  const [panel, setPanel] = useState<'steps' | 'remove' | null>(null);
  const [defaulting, setDefaulting] = useState(false);
  const [defaultError, setDefaultError] = useState<unknown>(null);
  const label = connection.hostname ?? connection.name;
  const detailId = `connection-detail-${connection.id}`;
  const toggle = (next: 'steps' | 'remove') => setPanel((current) => (current === next ? null : next));

  async function makeDefault() {
    setDefaulting(true);
    setDefaultError(null);
    try { await setDefaultEnvironment(connection.id); await onRefresh(); } catch (requestError) { setDefaultError(requestError); } finally { setDefaulting(false); }
  }

  return <>
    <tr className={`connections-table__row${panel ? ' is-open' : ''}`}>
      <td data-label={cols.type}><span className="connections-table__type"><EnvironmentIcon type={connection.type} />{t.deploy.targets[connection.type]}</span></td>
      <th scope="row" data-label={cols.name}><span className="connections-table__name">{connection.name}</span></th>
      <td data-label={cols.detail}><span className="connections-table__detail">
        <code>{connection.type === 'aws' ? connection.region ?? '—' : connection.hostname ?? '—'}</code>
        {connection.isDefault && <span className="connection-badge">{copy.default}</span>}
      </span></td>
      <td data-label={cols.status}>{connection.type === 'aws'
        ? <StatusTape tone="success">{copy.awsReady}</StatusTape>
        : <AgentState connection={connection} now={now} />}</td>
      <td className="connections-table__actions">
        <div className="connections-table__buttons">
          {connection.type === 'onprem' && <Keycap variant="ghost" aria-expanded={panel === 'steps'} aria-controls={panel === 'steps' ? detailId : undefined} onClick={() => toggle('steps')}>
            {panel === 'steps' ? copy.agent.hideSteps : copy.agent.showSteps}<span className="visually-hidden"> {label}</span>
          </Keycap>}
          {!connection.isDefault && <Keycap variant="ghost" disabled={defaulting} onClick={() => void makeDefault()}>
            {defaulting ? copy.makingDefault : copy.makeDefault}<span className="visually-hidden"> {label}</span>
          </Keycap>}
          <Keycap variant="ghost" aria-expanded={panel === 'remove'} aria-controls={panel === 'remove' ? detailId : undefined} onClick={() => toggle('remove')}>
            {copy.remove}<span className="visually-hidden"> {label}</span>
          </Keycap>
        </div>
        {defaultError !== null && <p className="connection-confirm__error" role="alert">{copy.makeDefaultError} {errorMessage(defaultError, t, copy.makeDefaultError)}</p>}
      </td>
    </tr>
    {panel && <tr className="connections-table__expand">
      <td colSpan={COLUMNS} id={detailId}>
        {panel === 'steps'
          ? <AgentInstallSteps environmentId={connection.id} initialToken={freshToken} />
          : <RemoveConfirm connection={connection} others={others} onRemoved={onRefresh} onCancel={() => setPanel(null)} />}
      </td>
    </tr>}
  </>;
}

/**
 * 연결 (#218, #236): AWS 계정과 온프레미스 서버를 한 번만 등록해 두고, 간단 배포에서 앱마다 골라 쓴다.
 * 등록한 연결은 한 표에서 관리하고(기본 지정 · 삭제 · Agent 설치 안내), 새 연결은 "연결 추가" 창에서 탭으로 골라 등록한다.
 * 여기서 다루는 것은 공용 연결뿐이다. 예전에 앱 하나에만 등록한 연결은 그 앱의 설정 탭에서 볼 수 있다.
 */
export function ConnectionsPage() {
  const { t } = useI18n();
  const copy = t.connections;
  const { state, refresh, retry } = useSharedConnections();
  const [adding, setAdding] = useState(false);
  /** 방금 등록한 서버의 Agent 등록 토큰 (한 번만 받는 값이라 화면 상태에만 둔다) */
  const [freshTokens, setFreshTokens] = useState<Record<string, AgentRegistrationToken>>({});

  const ready = state.phase === 'ready';
  const head = <div className="page-head">
    <div><h1>{copy.title}</h1><p>{copy.description}</p></div>
    {ready && <div className="page-head__actions"><Keycap variant="primary" onClick={() => setAdding(true)}>{copy.add}</Keycap></div>}
  </div>;

  if (state.phase === 'loading') return <>{head}<p className="dashboard-status" role="status">{copy.loading}</p></>;
  if (state.phase === 'error') return <>{head}<div className="notice error dashboard-error" role="alert">
    <strong>{copy.loadError}</strong><br />{errorMessage(state.error, t, copy.loadError)}
    <div className="page-actions"><Keycap variant="secondary" onClick={retry}>{t.dashboard.retry}</Keycap></div>
  </div></>;

  const { connections, loadedAt } = state;
  // AWS를 먼저 (어느 배포든 이미지는 AWS 계정에 둔다). 기본을 바꿔도 줄 순서는 그대로 둔다.
  const sorted = [...connections].sort((a, b) => (a.type === b.type ? 0 : a.type === 'aws' ? -1 : 1));
  const cols = copy.columns;

  return <>
    {head}
    {connections.length === 0
      ? <section className="connections-empty" aria-label={copy.emptyTitle}>
        <Koro size={56} />
        <div>
          <h2>{copy.emptyTitle}</h2>
          <p>{copy.emptyCopy}</p>
        </div>
      </section>
      : <section className="connections-area" aria-label={copy.tableLabel}><div className="connections-card">
        <table className="connections-table">
          <thead><tr>
            <th scope="col">{cols.type}</th><th scope="col">{cols.name}</th><th scope="col">{cols.detail}</th><th scope="col">{cols.status}</th>
            <th scope="col"><span className="visually-hidden">{cols.actions}</span></th>
          </tr></thead>
          <tbody>{sorted.map((connection) => <ConnectionRow key={connection.id} connection={connection} now={loadedAt}
            others={connections.filter((other) => other.id !== connection.id)} freshToken={freshTokens[connection.id] ?? null} onRefresh={refresh} />)}</tbody>
        </table>
      </div></section>}
    {connections.some((connection) => connection.type === 'onprem') && <p className="aws-key-form__note connections-note">{copy.agent.autoRefresh}</p>}

    <AddConnectionDialog open={adding} takenNames={connections.map((connection) => connection.name)} onRefresh={refresh}
      onTokenIssued={(id, token) => setFreshTokens((current) => ({ ...current, [id]: token }))} onClose={() => setAdding(false)} />
  </>;
}
