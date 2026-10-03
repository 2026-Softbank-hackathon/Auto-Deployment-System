import { useId, useState, type KeyboardEvent } from 'react';
import { issueAgentRegistrationToken, type AgentRegistrationToken } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { CommandBlock } from '../setup/CommandBlock';

/** apps/onprem-agent/README.md 의 Release 설치 · 등록 · 시작 절차 그대로. */
const AGENT_BIN = '"$HOME/Library/Application Support/Camellia/onprem-agent/bin';
const WINDOWS_AGENT = '"$env:LOCALAPPDATA\\Camellia\\onprem-agent\\bin\\camellia-onprem-agent.cmd"';
/** 설치기가 Mac 아키텍처(Intel x86_64 · Apple Silicon arm64)를 감지해 맞는 Release 파일을 받는다. 버전을 올릴 때는 여기 한 곳만 바꾼다. */
const AGENT_VERSION = 'v0.1.10';
const RELEASE_URL = `https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/releases/download/onprem-agent-${AGENT_VERSION}`;

type AgentOs = 'macos' | 'windows';
const agentOses: AgentOs[] = ['macos', 'windows'];

const installCommands: Record<AgentOs, string> = {
  macos: [
    'curl -fsSL \\',
    `  ${RELEASE_URL}/install-agent.sh \\`,
    `  | sh -s -- ${AGENT_VERSION}`,
  ].join('\n'),
  // PowerShell 5.1 은 TLS 1.2 를 직접 켜야 GitHub 에서 받을 수 있다
  windows: [
    "[Net.ServicePointManager]::SecurityProtocol = 'Tls12'",
    `Invoke-WebRequest -UseBasicParsing -OutFile "$env:TEMP\\install-agent.ps1" ${RELEASE_URL}/install-agent.ps1`,
    `powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\\install-agent.ps1" ${AGENT_VERSION}`,
  ].join('\n'),
};
const startCommands: Record<AgentOs, string> = {
  macos: `${AGENT_BIN}/camellia-onprem-agent-service" start`,
  windows: `& ${WINDOWS_AGENT} start`,
};

/** Agent가 접속할 Control Plane 주소. 화면을 띄운 주소(프록시 포함)와 같은 origin을 안내한다. */
function controlPlaneUrl(): string { return window.location.origin; }

function registerCommand(os: AgentOs, token: string): string {
  if (os === 'windows') {
    return [
      `$env:ONPREM_CONTROL_PLANE_URL = '${controlPlaneUrl()}'`,
      `$env:ONPREM_AGENT_REGISTRATION_TOKEN = '${token}'`,
      `& ${WINDOWS_AGENT} register`,
      'Remove-Item Env:ONPREM_AGENT_REGISTRATION_TOKEN',
    ].join('\n');
  }
  return [
    `ONPREM_CONTROL_PLANE_URL=${controlPlaneUrl()} \\`,
    `ONPREM_AGENT_REGISTRATION_TOKEN=${token} \\`,
    `${AGENT_BIN}/camellia-onprem-agent" register`,
  ].join('\n');
}

/** 접속한 PC가 Windows면 Windows 명령을 먼저 보여 준다. 서버가 다른 기기일 수 있어 바꿀 수 있게 둔다. */
function guessOs(): AgentOs {
  return /Windows/i.test(navigator.userAgent) ? 'windows' : 'macos';
}

/**
 * 온프레미스 서버에 Agent를 설치 → 1회용 토큰으로 등록 → 시작하는 순서.
 * 등록 토큰은 서버가 한 번만 돌려주므로 화면 상태에만 두고 저장하지 않는다. 서버를 막 등록했으면 발급한 토큰(initialToken)을 바로 보여 준다.
 */
export function AgentInstallSteps({ environmentId, initialToken = null }: { environmentId: string; initialToken?: AgentRegistrationToken | null }) {
  const { t } = useI18n();
  const copy = t.connections.agent;
  const baseId = useId();
  const [os, setOs] = useState<AgentOs>(guessOs);
  const [token, setToken] = useState<AgentRegistrationToken | null>(initialToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function issue() {
    setBusy(true);
    setError(null);
    try { setToken(await issueAgentRegistrationToken(environmentId)); } catch (requestError) { setError(requestError); } finally { setBusy(false); }
  }

  function moveTab(event: KeyboardEvent<HTMLButtonElement>, current: AgentOs) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = agentOses[(agentOses.indexOf(current) + step + agentOses.length) % agentOses.length];
    setOs(next);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  }

  return <div className="agent-steps">
    <div className="tabs" role="tablist" aria-label={copy.osLabel}>
      {agentOses.map((key) => <button key={key} type="button" role="tab" id={`${baseId}-tab-${key}`} className="tabs__tab"
        aria-selected={os === key} aria-controls={`${baseId}-panel`} tabIndex={os === key ? 0 : -1}
        onClick={() => setOs(key)} onKeyDown={(event) => moveTab(event, key)}>{copy.os[key]}</button>)}
    </div>
    <div role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${os}`}>
      <ul className="setup-requirements" aria-label={copy.requirementsLabel}>
        {copy.requirements[os].map((item) => <li key={item}>{item}</li>)}
      </ul>
      <ol className="setup-agent-steps">
        <li>
          <strong>{copy.stepInstall}</strong>
          <CommandBlock command={installCommands[os]} label={copy.stepInstall} />
        </li>
        <li>
          <strong>{copy.stepRegister}</strong>
          <p>{copy.registerCopy}</p>
          {token && <>
            <CommandBlock command={registerCommand(os, token.token)} label={copy.stepRegister} />
            <p className="aws-key-form__note">{copy.tokenNote(new Date(token.expiresAt).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' }))}</p>
          </>}
          {error !== null && <div className="notice error" role="alert"><strong>{copy.tokenError}</strong><br />{errorMessage(error, t, copy.tokenError)}</div>}
          <div><Keycap variant="secondary" onClick={() => void issue()} disabled={busy}>{busy ? copy.issuing : token ? copy.reissue : copy.issue}</Keycap></div>
        </li>
        <li>
          <strong>{copy.stepStart}</strong>
          <CommandBlock command={startCommands[os]} label={copy.stepStart} />
        </li>
      </ol>
    </div>
  </div>;
}
