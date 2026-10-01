import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { issueAgentRegistrationToken, type AgentRegistrationToken, type EnvironmentSummary } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { Koro } from '../../components/ui/Koro';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';

type Step = 'host' | 'agent';
const steps: readonly Step[] = ['host', 'agent'];
const HOST_MAX = 128;

/** Agent가 접속할 Control Plane 주소. 화면을 띄운 주소(프록시 포함)와 같은 origin을 안내한다. */
function controlPlaneUrl(): string { return window.location.origin; }

/**
 * 온프레미스 연결: ① 호스트 이름으로 환경 등록 → ② 1회용 Agent 등록 토큰 발급과 실행 명령 안내.
 * 토큰은 서버가 한 번만 돌려주므로 화면 상태에만 두고 저장하지 않는다. 이미 등록된 환경이면 토큰 발급만 한다.
 */
export function OnpremDialog({ environment, onRegisterHost, onClose }: {
  environment: EnvironmentSummary | null;
  onRegisterHost: (hostname: string) => Promise<EnvironmentSummary>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const hostId = useId();
  const [current, setCurrent] = useState<EnvironmentSummary | null>(environment);
  const [step, setStep] = useState<Step>(environment ? 'agent' : 'host');
  const [hostname, setHostname] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [token, setToken] = useState<AgentRegistrationToken | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    dialog.querySelector('input')?.focus();
  }, []);

  async function issue(target: EnvironmentSummary) {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setToken(await issueAgentRegistrationToken(target.id));
    } catch (requestError) {
      setError(requestError);
    } finally {
      setBusy(false);
    }
  }

  async function submitHost(event: FormEvent) {
    event.preventDefault();
    const trimmed = hostname.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await onRegisterHost(trimmed);
      setCurrent(created);
      setStep('agent');
      setBusy(false);
      await issue(created);
    } catch (requestError) {
      setError(requestError);
      setBusy(false);
    }
  }

  const command = token ? [
    `ONPREM_CONTROL_PLANE_URL=${controlPlaneUrl()} \\`,
    `ONPREM_AGENT_REGISTRATION_TOKEN=${token.token} \\`,
    '"$HOME/Library/Application Support/Camellia/onprem-agent/bin/camellia-onprem-agent" register',
  ].join('\n') : '';

  async function copy() {
    try { await navigator.clipboard.writeText(command); setCopied(true); } catch { setCopied(false); }
  }

  return <dialog ref={dialogRef} className="setup-dialog" aria-labelledby={titleId} onClose={onClose}
    onCancel={(event) => { if (busy) event.preventDefault(); }}>
    <div className="setup-dialog__head">
      <Koro mood="normal" size={44} />
      <h2 id={titleId}>{t.deploy.onprem.title}</h2>
      <button type="button" className="setup-dialog__close" aria-label={t.deploy.setup.close} onClick={() => dialogRef.current?.close()} disabled={busy}>×</button>
    </div>

    <ol className="setup-steps" aria-label={t.deploy.setup.stepsLabel}>
      {steps.map((item, index) => {
        const state = steps.indexOf(step) > index ? 'done' : step === item ? 'current' : 'pending';
        return <li key={item} className={`setup-steps__item is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
          <span className="setup-steps__no" aria-hidden="true">{state === 'done' ? '✓' : index + 1}</span>{t.deploy.onprem.steps[item]}
        </li>;
      })}
    </ol>

    {step === 'host' && <form className="setup-dialog__body" onSubmit={(event) => void submitHost(event)} autoComplete="off">
      <h3>{t.deploy.onprem.hostQuestion}</h3>
      <p>{t.deploy.onprem.hostCopy}</p>
      <div className="aws-key-form__field">
        <label htmlFor={hostId}>{t.deploy.onprem.hostLabel}</label>
        <input id={hostId} value={hostname} onChange={(event) => setHostname(event.target.value)} maxLength={HOST_MAX} required autoComplete="off" spellCheck={false} disabled={busy} />
      </div>
      {error !== null && <div className="notice error" role="alert"><strong>{t.deploy.onprem.hostError}</strong><br />{errorMessage(error, t, t.deploy.onprem.hostError)}</div>}
      <div className="setup-dialog__actions">
        <Keycap type="submit" disabled={busy || !hostname.trim()}>{busy ? t.deploy.aws.saving : t.deploy.setup.next}</Keycap>
      </div>
    </form>}

    {step === 'agent' && <div className="setup-dialog__body">
      <h3>{t.deploy.onprem.agentQuestion}</h3>
      <p>{t.deploy.onprem.agentCopy}</p>
      {current?.hostname && <p className="setup-dialog__app">{t.deploy.onprem.hostLine(current.hostname)}</p>}
      {error !== null && <div className="notice error" role="alert"><strong>{t.deploy.onprem.tokenError}</strong><br />{errorMessage(error, t, t.deploy.onprem.tokenError)}</div>}
      {token && <>
        <pre className="onprem-command" tabIndex={0} aria-label={t.deploy.onprem.commandLabel}>{command}</pre>
        <p className="aws-key-form__note">{t.deploy.onprem.tokenNote(new Date(token.expiresAt).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' }))}</p>
      </>}
      <div className="setup-dialog__actions">
        {token && <Keycap variant="secondary" onClick={() => void copy()}>{copied ? t.deploy.onprem.copied : t.deploy.onprem.copy}</Keycap>}
        {current && <Keycap variant={token ? 'ghost' : 'secondary'} onClick={() => void issue(current)} disabled={busy}>{busy ? t.deploy.onprem.issuing : token ? t.deploy.onprem.reissue : t.deploy.onprem.issue}</Keycap>}
        <Keycap onClick={() => dialogRef.current?.close()} disabled={busy}>{t.deploy.onprem.done}</Keycap>
      </div>
    </div>}
  </dialog>;
}
