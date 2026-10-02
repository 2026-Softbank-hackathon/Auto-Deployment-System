import { useState } from 'react';
import { issueAgentRegistrationToken, type AgentRegistrationToken } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { CommandBlock } from '../setup/CommandBlock';

/** apps/onprem-agent/README.md 의 Release 설치 · 등록 · 시작 절차 그대로. */
const AGENT_BIN = '"$HOME/Library/Application Support/Camellia/onprem-agent/bin';
/** 설치기가 Mac 아키텍처(Intel x86_64 · Apple Silicon arm64)를 감지해 맞는 Release 파일을 받는다. 버전을 올릴 때는 여기 한 곳만 바꾼다. */
const AGENT_VERSION = 'v0.1.6';
const installCommand = [
  'curl -fsSL \\',
  `  https://github.com/2026-Softbank-hackathon/Auto-Deployment-System/releases/download/onprem-agent-${AGENT_VERSION}/install-agent.sh \\`,
  `  | sh -s -- ${AGENT_VERSION}`,
].join('\n');
const startCommand = `${AGENT_BIN}/camellia-onprem-agent-service" start`;

/** Agent가 접속할 Control Plane 주소. 화면을 띄운 주소(프록시 포함)와 같은 origin을 안내한다. */
function controlPlaneUrl(): string { return window.location.origin; }

/**
 * 온프레미스 서버에 Agent를 설치 → 1회용 토큰으로 등록 → 시작하는 순서.
 * 등록 토큰은 서버가 한 번만 돌려주므로 화면 상태에만 두고 저장하지 않는다. 서버를 막 등록했으면 발급한 토큰(initialToken)을 바로 보여 준다.
 */
export function AgentInstallSteps({ environmentId, initialToken = null }: { environmentId: string; initialToken?: AgentRegistrationToken | null }) {
  const { t } = useI18n();
  const copy = t.connections.agent;
  const [token, setToken] = useState<AgentRegistrationToken | null>(initialToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function issue() {
    setBusy(true);
    setError(null);
    try { setToken(await issueAgentRegistrationToken(environmentId)); } catch (requestError) { setError(requestError); } finally { setBusy(false); }
  }

  const registerCommand = token ? [
    `ONPREM_CONTROL_PLANE_URL=${controlPlaneUrl()} \\`,
    `ONPREM_AGENT_REGISTRATION_TOKEN=${token.token} \\`,
    `${AGENT_BIN}/camellia-onprem-agent" register`,
  ].join('\n') : null;

  return <div className="agent-steps">
    <ul className="setup-requirements" aria-label={copy.requirementsLabel}>
      {copy.requirements.map((item) => <li key={item}>{item}</li>)}
    </ul>
    <ol className="setup-agent-steps">
      <li>
        <strong>{copy.stepInstall}</strong>
        <CommandBlock command={installCommand} label={copy.stepInstall} />
      </li>
      <li>
        <strong>{copy.stepRegister}</strong>
        <p>{copy.registerCopy}</p>
        {registerCommand && token && <>
          <CommandBlock command={registerCommand} label={copy.stepRegister} />
          <p className="aws-key-form__note">{copy.tokenNote(new Date(token.expiresAt).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' }))}</p>
        </>}
        {error !== null && <div className="notice error" role="alert"><strong>{copy.tokenError}</strong><br />{errorMessage(error, t, copy.tokenError)}</div>}
        <div><Keycap variant="secondary" onClick={() => void issue()} disabled={busy}>{busy ? copy.issuing : token ? copy.reissue : copy.issue}</Keycap></div>
      </li>
      <li>
        <strong>{copy.stepStart}</strong>
        <CommandBlock command={startCommand} label={copy.stepStart} />
      </li>
    </ol>
  </div>;
}
