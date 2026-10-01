import { useId, useState, type FormEvent } from 'react';
import { issueAgentRegistrationToken, type AgentRegistrationToken, type EnvironmentSummary } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { CommandBlock } from './CommandBlock';

const HOST_MAX = 128;
/** apps/onprem-agent/README.md 의 설치 · 등록 · 시작 절차 그대로. */
const AGENT_BIN = '"$HOME/Library/Application Support/Camellia/onprem-agent/bin';
const installCommand = 'pnpm --filter @camellia/onprem-agent build\napps/onprem-agent/install/macos/install.sh';
const startCommand = `${AGENT_BIN}/camellia-onprem-agent-service" start`;

/** Agent가 접속할 Control Plane 주소. 화면을 띄운 주소(프록시 포함)와 같은 origin을 안내한다. */
function controlPlaneUrl(): string { return window.location.origin; }

/**
 * 온프레미스 연결(선택): 서버 등록 → Agent 설치 → 1회용 토큰으로 Agent 등록 → Agent 시작.
 * 등록 토큰은 서버가 한 번만 돌려주므로 화면 상태에만 두고 저장하지 않는다.
 */
export function OnpremCard({ hasProject, environment, onRegisterHost }: {
  hasProject: boolean;
  environment: EnvironmentSummary | null;
  onRegisterHost: (hostname: string) => Promise<EnvironmentSummary>;
}) {
  const { t } = useI18n();
  const hostId = useId();
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [token, setToken] = useState<AgentRegistrationToken | null>(null);

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
    <p className="aws-key-form__note">{t.setup.onprem.statusNote}</p>
  </>;
}
