import { useId, useState, type FormEvent, type ReactNode } from 'react';
import {
  createSharedAwsConnection, createSharedOnpremConnection, deleteEnvironment, deleteSharedSecret, DeploymentApiError, issueAgentRegistrationToken,
  type AgentRegistrationToken, type EnvironmentSummary,
} from '../api/deployment-api';
import { Keycap } from '../components/ui/Keycap';
import { Koro } from '../components/ui/Koro';
import { AgentInstallSteps } from '../features/connections/AgentInstallSteps';
import { AgentState } from '../features/connections/AgentState';
import { useSharedConnections } from '../features/connections/useSharedConnections';
import { AwsKeyForm } from '../features/deployment-start/AwsKeyForm';
import { errorMessage, useI18n } from '../i18n/I18nProvider';

const HOST_MAX = 128;

function Section({ title, copy, count, children }: { title: string; copy: string; count: number; children: ReactNode }) {
  const titleId = useId();
  return <section className="setup-card" aria-labelledby={titleId}>
    <div className="setup-card__head">
      <h2 id={titleId}>{title}</h2>
      <span className="connections__count">{count}</span>
    </div>
    <div className="setup-card__body">
      <p>{copy}</p>
      {children}
    </div>
  </section>;
}

/** 연결 한 줄의 삭제 버튼. 브라우저 확인 창 대신 줄 안에서 한 번 더 묻는다. */
function RemoveConnection({ connection, others, onRemoved }: { connection: EnvironmentSummary; /** 남는 공용 연결 (키를 같이 쓰는지 확인용) */ others: EnvironmentSummary[]; onRemoved: () => Promise<void> }) {
  const { t } = useI18n();
  const copy = t.connections;
  const [confirming, setConfirming] = useState(false);
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
    setBusy(false);
    setConfirming(false);
  }

  if (!confirming) return <Keycap variant="ghost" onClick={() => setConfirming(true)}>{copy.remove}<span className="visually-hidden"> {connection.name}</span></Keycap>;
  return <div className="connection-row__confirm" role="group" aria-label={copy.remove}>
    <p>{copy.removeConfirm(connection.hostname ?? connection.name)}</p>
    {error !== null && <p className="connection-row__error" role="alert">
      {error instanceof DeploymentApiError && error.status === 409 ? copy.removeInUse : `${copy.removeError} ${errorMessage(error, t, copy.removeError)}`}
    </p>}
    <div className="aws-key-form__actions">
      <Keycap variant="secondary" disabled={busy} onClick={() => void remove()}>{busy ? copy.removing : copy.removeYes}</Keycap>
      <Keycap variant="ghost" disabled={busy} onClick={() => { setConfirming(false); setError(null); }}>{copy.cancel}</Keycap>
    </div>
  </div>;
}

function OnpremForm({ takenNames, onCreated, onCancel }: { takenNames: string[]; onCreated: (id: string, token: AgentRegistrationToken | null) => Promise<void>; onCancel?: () => void }) {
  const { t } = useI18n();
  const copy = t.connections.onprem;
  const hostId = useId();
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = hostname.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const id = await createSharedOnpremConnection(trimmed, takenNames);
      // 서버를 등록했으면 바로 Agent 등록 명령까지 보여 준다. 토큰 발급이 실패하면 설치 안내에서 다시 발급할 수 있다.
      const token = await issueAgentRegistrationToken(id).catch(() => null);
      await onCreated(id, token);
    } catch (requestError) {
      setError(requestError);
    } finally {
      setBusy(false);
    }
  }

  return <>
    <form className="setup-form" onSubmit={(event) => void submit(event)} autoComplete="off">
      <div className="aws-key-form__field">
        <label htmlFor={hostId}>{copy.hostLabel}</label>
        <input id={hostId} value={hostname} onChange={(event) => setHostname(event.target.value)} maxLength={HOST_MAX} required autoComplete="off" spellCheck={false} disabled={busy} placeholder={copy.hostPlaceholder} />
      </div>
      <Keycap type="submit" variant="secondary" disabled={busy || !hostname.trim()}>{busy ? copy.adding : copy.register}</Keycap>
      {onCancel && <Keycap variant="ghost" disabled={busy} onClick={onCancel}>{t.connections.cancel}</Keycap>}
    </form>
    {error !== null && <div className="notice error" role="alert"><strong>{copy.addError}</strong><br />{errorMessage(error, t, copy.addError)}</div>}
  </>;
}

/**
 * 연결 (#218): AWS 계정과 온프레미스 서버를 한 번만 등록해 두고, 간단 배포에서 앱마다 골라 쓴다.
 * 여기서 다루는 것은 공용 연결뿐이다. 예전에 앱 하나에만 등록한 연결은 그 앱의 설정 탭에서 볼 수 있다.
 */
export function ConnectionsPage() {
  const { t } = useI18n();
  const copy = t.connections;
  const { state, refresh, retry } = useSharedConnections();
  const [adding, setAdding] = useState<'aws' | 'onprem' | null>(null);
  /** 설치 안내를 펼친 온프레미스 연결 */
  const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(new Set());
  /** 방금 등록한 서버의 Agent 등록 토큰 (한 번만 받는 값이라 화면 상태에만 둔다) */
  const [freshTokens, setFreshTokens] = useState<Record<string, AgentRegistrationToken>>({});

  const head = <div className="page-head">
    <div><h1>{copy.title}</h1><p>{copy.description}</p></div>
  </div>;

  if (state.phase === 'loading') return <>{head}<p className="dashboard-status" role="status">{copy.loading}</p></>;
  if (state.phase === 'error') return <>{head}<div className="notice error dashboard-error" role="alert">
    <strong>{copy.loadError}</strong><br />{errorMessage(state.error, t, copy.loadError)}
    <div className="page-actions"><Keycap variant="secondary" onClick={retry}>{t.dashboard.retry}</Keycap></div>
  </div></>;

  const { connections, loadedAt } = state;
  const aws = connections.filter((connection) => connection.type === 'aws');
  const onprem = connections.filter((connection) => connection.type === 'onprem');
  const takenNames = connections.map((connection) => connection.name);
  const othersOf = (connection: EnvironmentSummary) => connections.filter((other) => other.id !== connection.id);
  // AWS 계정이 하나도 없으면 등록 칸을 바로 펼친다 (어느 배포든 이미지를 AWS 계정에 둔다).
  const showAwsForm = adding === 'aws' || aws.length === 0;
  const toggleSteps = (id: string) => setOpenSteps((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return <>
    {head}
    {connections.length === 0 && <section className="connections-empty" aria-label={copy.emptyTitle}>
      <Koro size={56} />
      <div>
        <h2>{copy.emptyTitle}</h2>
        <p>{copy.emptyCopy}</p>
      </div>
    </section>}

    <Section title={copy.aws.title} copy={copy.aws.copy} count={aws.length}>
      {aws.length > 0 && <ul className="connection-list" aria-label={copy.aws.title}>
        {aws.map((connection) => <li key={connection.id} className="connection-row">
          <div className="connection-row__main">
            <strong>{connection.region ?? connection.name}</strong>
            <span>{connection.name}</span>
          </div>
          <div className="connection-row__state">{connection.isDefault && <span className="connection-badge">{copy.default}</span>}</div>
          <div className="connection-row__actions"><RemoveConnection connection={connection} others={othersOf(connection)} onRemoved={refresh} /></div>
        </li>)}
      </ul>}
      {showAwsForm
        ? <AwsKeyForm onCancel={aws.length > 0 ? () => setAdding(null) : undefined}
          onSubmit={async (input) => { await createSharedAwsConnection(input, takenNames); await refresh(); setAdding(null); }} />
        : <div><Keycap variant="secondary" onClick={() => setAdding('aws')}>{copy.aws.add}</Keycap></div>}
    </Section>

    <Section title={copy.onprem.title} copy={copy.onprem.copy} count={onprem.length}>
      {onprem.length > 0 && <ul className="connection-list" aria-label={copy.onprem.title}>
        {onprem.map((connection) => {
          const stepsOpen = openSteps.has(connection.id);
          const stepsId = `agent-steps-${connection.id}`;
          return <li key={connection.id} className="connection-row">
            <div className="connection-row__main">
              <strong>{connection.hostname ?? connection.name}</strong>
              <span>{connection.name}</span>
            </div>
            <div className="connection-row__state">
              <AgentState connection={connection} now={loadedAt} />
              {connection.isDefault && <span className="connection-badge">{copy.default}</span>}
            </div>
            <div className="connection-row__actions">
              <Keycap variant="ghost" aria-expanded={stepsOpen} aria-controls={stepsId} onClick={() => toggleSteps(connection.id)}>
                {stepsOpen ? copy.agent.hideSteps : copy.agent.showSteps}<span className="visually-hidden"> {connection.hostname ?? connection.name}</span>
              </Keycap>
              <RemoveConnection connection={connection} others={othersOf(connection)} onRemoved={refresh} />
            </div>
            {stepsOpen && <div id={stepsId} className="connection-row__detail">
              <AgentInstallSteps environmentId={connection.id} initialToken={freshTokens[connection.id] ?? null} />
            </div>}
          </li>;
        })}
      </ul>}
      {onprem.length > 0 && <p className="aws-key-form__note">{copy.agent.autoRefresh}</p>}
      {adding === 'onprem'
        ? <OnpremForm takenNames={takenNames} onCancel={() => setAdding(null)}
          onCreated={async (id, token) => {
            if (token) setFreshTokens((current) => ({ ...current, [id]: token }));
            setOpenSteps((current) => new Set(current).add(id));
            await refresh();
            setAdding(null);
          }} />
        : <div><Keycap variant="secondary" onClick={() => setAdding('onprem')}>{copy.onprem.add}</Keycap></div>}
    </Section>
  </>;
}
