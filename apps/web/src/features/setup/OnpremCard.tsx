import { useId, useState, type FormEvent } from 'react';
import { DeploymentApiError, issueAgentRegistrationToken, type AgentRegistrationToken, type EnvironmentSummary } from '../../api/deployment-api';
import { StatusTape } from '../../components/ui/StatusTape';
import { relativeTime } from '../dashboard/format';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { CommandBlock } from './CommandBlock';

const HOST_MAX = 128;
/** apps/onprem-agent/README.md 의 Release 설치 · 등록 · 시작 절차 그대로. */
const AGENT_BIN = '"$HOME/Library/Application Support/Camellia/onprem-agent/bin';
/** 설치기가 Mac 아키텍처(Intel x86_64 · Apple Silicon arm64)를 감지해 맞는 Release 파일을 받는다. 버전을 올릴 때는 여기 한 곳만 바꾼다. */
const AGENT_VERSION = 'v0.1.3';
const installCommand = [
  'curl -fsSL \\',
  `  https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/releases/download/onprem-agent-${AGENT_VERSION}/install-agent.sh \\`,
  `  | sh -s -- ${AGENT_VERSION}`,
].join('\n');
const startCommand = `${AGENT_BIN}/camellia-onprem-agent-service" start`;

/** Agent는 15초마다 연결을 알린다 (apps/onprem-agent heartbeatIntervalMs). 세 번 놓치면 끊긴 것으로 본다. */
const AGENT_ONLINE_WITHIN_MS = 45_000;

/** Agent가 접속할 Control Plane 주소. 화면을 띄운 주소(프록시 포함)와 같은 origin을 안내한다. */
function controlPlaneUrl(): string { return window.location.origin; }

/**
 * 온프레미스 연결(선택): 서버 등록 → Agent 설치 → 1회용 토큰으로 Agent 등록 → Agent 시작.
 * 등록 토큰은 서버가 한 번만 돌려주므로 화면 상태에만 두고 저장하지 않는다.
 */
export function OnpremCard({ hasProject, environment, onRegisterHost, onRemoveHost, onRefresh }: {
  hasProject: boolean;
  environment: EnvironmentSummary | null;
  onRegisterHost: (hostname: string) => Promise<EnvironmentSummary>;
  onRemoveHost: (environmentId: string) => Promise<void>;
  /** 연결 상태를 다시 읽는다 */
  onRefresh: () => Promise<void>;
}) {
  const { t } = useI18n();
  const hostId = useId();
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [token, setToken] = useState<AgentRegistrationToken | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removeError, setRemoveError] = useState<unknown>(null);

  async function submitHost(event: FormEvent) {
    event.preventDefault();
    const trimmed = hostname.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try { await onRegisterHost(trimmed); setHostname(''); } catch (requestError) { setError(requestError); } finally { setBusy(false); }
  }

  async function issue(target: EnvironmentSummary) {
    setBusy(true);
    setError(null);
    try { setToken(await issueAgentRegistrationToken(target.id)); } catch (requestError) { setError(requestError); } finally { setBusy(false); }
  }

  async function remove(target: EnvironmentSummary) {
    setBusy(true);
    setRemoveError(null);
    try { await onRemoveHost(target.id); setToken(null); setConfirmingRemove(false); } catch (requestError) { setRemoveError(requestError); } finally { setBusy(false); }
  }

  const requirements = <ul className="setup-requirements">
    {t.setup.onprem.requirements.map((item) => <li key={item}>{item}</li>)}
  </ul>;

  if (!hasProject) return <><p>{t.setup.needsApp}</p>{requirements}</>;

  if (!environment) return <>
    <p>{t.setup.onprem.copy}</p>
    {requirements}
    <form className="setup-form" onSubmit={(event) => void submitHost(event)} autoComplete="off">
      <div className="aws-key-form__field">
        <label htmlFor={hostId}>{t.setup.onprem.hostLabel}</label>
        <input id={hostId} value={hostname} onChange={(event) => setHostname(event.target.value)} maxLength={HOST_MAX} required autoComplete="off" spellCheck={false} disabled={busy} />
      </div>
      <Keycap type="submit" variant="secondary" disabled={busy || !hostname.trim()}>{busy ? t.deploy.aws.saving : t.setup.onprem.register}</Keycap>
    </form>
    {error !== null && <div className="notice error" role="alert"><strong>{t.setup.onprem.hostError}</strong><br />{errorMessage(error, t, t.setup.onprem.hostError)}</div>}
  </>;

  const registerCommand = token ? [
    `ONPREM_CONTROL_PLANE_URL=${controlPlaneUrl()} \\`,
    `ONPREM_AGENT_REGISTRATION_TOKEN=${token.token} \\`,
    `${AGENT_BIN}/camellia-onprem-agent" register`,
  ].join('\n') : null;

  return <>
    <p className="setup-card__value">{environment.hostname ?? environment.name}</p>
    <AgentStatus lastSeenAt={environment.lastSeenAt} busy={busy} onRefresh={onRefresh} />
    <p>{t.setup.onprem.agentCopy}</p>
    {requirements}
    <ol className="setup-agent-steps">
      <li>
        <strong>{t.setup.onprem.stepInstall}</strong>
        <CommandBlock command={installCommand} label={t.setup.onprem.stepInstall} />
      </li>
      <li>
        <strong>{t.setup.onprem.stepRegister}</strong>
        <p>{t.setup.onprem.registerCopy}</p>
        {registerCommand && token && <>
          <CommandBlock command={registerCommand} label={t.setup.onprem.stepRegister} />
          <p className="aws-key-form__note">{t.setup.onprem.tokenNote(new Date(token.expiresAt).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' }))}</p>
        </>}
        {error !== null && <div className="notice error" role="alert"><strong>{t.setup.onprem.tokenError}</strong><br />{errorMessage(error, t, t.setup.onprem.tokenError)}</div>}
        <div><Keycap variant="secondary" onClick={() => void issue(environment)} disabled={busy}>{busy ? t.setup.onprem.issuing : token ? t.setup.onprem.reissue : t.setup.onprem.issue}</Keycap></div>
      </li>
      <li>
        <strong>{t.setup.onprem.stepStart}</strong>
        <CommandBlock command={startCommand} label={t.setup.onprem.stepStart} />
      </li>
    </ol>
    {/* 호스트 이름을 바꾸는 API는 없다. 바꾸려면 등록을 해제하고 다시 등록한다. */}
    <div className="setup-remove">
      {confirmingRemove
        ? <>
          <p>{t.setup.onprem.removeConfirm}</p>
          <div className="aws-key-form__actions">
            <Keycap variant="secondary" disabled={busy} onClick={() => void remove(environment)}>{busy ? t.setup.onprem.removing : t.setup.onprem.removeYes}</Keycap>
            <Keycap variant="ghost" disabled={busy} onClick={() => { setConfirmingRemove(false); setRemoveError(null); }}>{t.deploy.aws.cancel}</Keycap>
          </div>
        </>
        : <div><Keycap variant="ghost" disabled={busy} onClick={() => setConfirmingRemove(true)}>{t.setup.onprem.remove}</Keycap></div>}
      {removeError !== null && <div className="notice error" role="alert"><strong>{t.setup.onprem.removeError}</strong><br />
        {removeError instanceof DeploymentApiError && removeError.status === 409 ? t.setup.onprem.removeActive : t.setup.onprem.removeUsed}</div>}
    </div>
  </>;
}

/** Agent 연결 상태. 서버가 마지막 연결 시각을 주지 않으면 "확인할 수 없음"으로 두고 추정하지 않는다. */
function AgentStatus({ lastSeenAt, busy, onRefresh }: { lastSeenAt: string | null; busy: boolean; onRefresh: () => Promise<void> }) {
  const { t } = useI18n();
  const copy = t.setup.onprem;
  const now = Date.now();
  const online = lastSeenAt !== null && now - Date.parse(lastSeenAt) <= AGENT_ONLINE_WITHIN_MS;
  return <div className="agent-status">
    {lastSeenAt === null
      ? <p className="aws-key-form__note">{copy.statusNote}</p>
      : <>
        <StatusTape tone={online ? 'success' : 'waiting'}>{online ? copy.agentOnline : copy.agentOffline}</StatusTape>
        <span className="agent-status__seen">{copy.agentLastSeen(relativeTime(lastSeenAt, now, t))}</span>
      </>}
    <Keycap variant="ghost" disabled={busy} onClick={() => void onRefresh()}>{copy.statusRefresh}</Keycap>
  </div>;
}
