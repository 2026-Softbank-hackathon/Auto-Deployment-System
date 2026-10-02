import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createSharedAwsConnection, createSharedOnpremConnection, issueAgentRegistrationToken, type AgentRegistrationToken } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { EnvironmentIcon } from '../dashboard/DeploymentRow';
import { AwsKeyForm } from '../deployment-start/AwsKeyForm';
import { AgentInstallSteps } from './AgentInstallSteps';

const HOST_MAX = 128;
const kinds = ['aws', 'onprem'] as const;
type Kind = typeof kinds[number];

function OnpremForm({ takenNames, onCreated, onCancel }: { takenNames: string[]; onCreated: (id: string, hostname: string, token: AgentRegistrationToken | null) => Promise<void>; onCancel: () => void }) {
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
      await onCreated(id, trimmed, token);
    } catch (requestError) {
      setError(requestError);
    } finally {
      setBusy(false);
    }
  }

  return <form className="aws-key-form" onSubmit={(event) => void submit(event)} autoComplete="off">
    <div className="aws-key-form__field">
      <label htmlFor={hostId}>{copy.hostLabel}</label>
      <input id={hostId} value={hostname} onChange={(event) => setHostname(event.target.value)} maxLength={HOST_MAX} required autoFocus autoComplete="off" spellCheck={false} disabled={busy} placeholder={copy.hostPlaceholder} />
    </div>
    {error !== null && <div className="notice error" role="alert"><strong>{copy.addError}</strong><br />{errorMessage(error, t, copy.addError)}</div>}
    <div className="aws-key-form__actions">
      <Keycap type="submit" variant="secondary" disabled={busy || !hostname.trim()}>{busy ? copy.adding : copy.register}</Keycap>
      <Keycap variant="ghost" disabled={busy} onClick={onCancel}>{t.connections.cancel}</Keycap>
    </div>
  </form>;
}

/** 창 안의 내용. 창을 닫으면 통째로 내려서 입력값 · 탭 · 발급한 토큰이 남지 않게 한다. */
function AddConnectionBody({ titleId, takenNames, onRefresh, onTokenIssued, onClose }: {
  titleId: string; takenNames: string[]; onRefresh: () => Promise<void>;
  onTokenIssued: (id: string, token: AgentRegistrationToken) => void; onClose: () => void;
}) {
  const { t } = useI18n();
  const copy = t.connections;
  const baseId = useId();
  const [kind, setKind] = useState<Kind>('aws');
  /** 방금 등록한 온프레미스 서버. 등록 뒤에는 탭 대신 Agent 설치 순서를 보여 준다. */
  const [created, setCreated] = useState<{ id: string; hostname: string; token: AgentRegistrationToken | null } | null>(null);

  // 탭 목록에서는 좌우 화살표로 옮긴다 (환경설정 창과 같은 방식).
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, current: Kind) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = kinds[(kinds.indexOf(current) + step + kinds.length) % kinds.length];
    setKind(next);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  }

  const head = <div className="picker-dialog__head">
    <h2 id={titleId}>{created ? copy.addDialog.createdTitle(created.hostname) : copy.addDialog.title}</h2>
    <button type="button" className="toast__close" aria-label={copy.addDialog.close} onClick={onClose}>×</button>
  </div>;

  if (created) return <>
    {head}
    <p>{copy.addDialog.createdCopy}</p>
    <AgentInstallSteps environmentId={created.id} initialToken={created.token} />
    <div className="picker-dialog__actions"><span /><Keycap variant="secondary" onClick={onClose}>{copy.addDialog.done}</Keycap></div>
  </>;

  return <>
    {head}
    <div className="tabs" role="tablist" aria-label={copy.addDialog.title}>
      {kinds.map((key) => <button key={key} type="button" role="tab" id={`${baseId}-tab-${key}`} className="tabs__tab connection-dialog__tab"
        aria-selected={kind === key} aria-controls={`${baseId}-panel-${key}`} tabIndex={kind === key ? 0 : -1}
        onClick={() => setKind(key)} onKeyDown={(event) => moveTab(event, key)}><EnvironmentIcon type={key} />{copy[key].title}</button>)}
    </div>
    <div className="connection-dialog__panel" role="tabpanel" id={`${baseId}-panel-${kind}`} aria-labelledby={`${baseId}-tab-${kind}`}>
      <p>{copy[kind].copy}</p>
      {kind === 'aws'
        ? <AwsKeyForm autoFocus onCancel={onClose}
          onSubmit={async (input) => { await createSharedAwsConnection(input, takenNames); await onRefresh(); onClose(); }} />
        : <OnpremForm takenNames={takenNames} onCancel={onClose}
          onCreated={async (id, hostname, token) => {
            if (token) onTokenIssued(id, token);
            setCreated({ id, hostname, token });
            await onRefresh();
          }} />}
    </div>
  </>;
}

/**
 * 연결 추가 창 (#236). AWS 계정 / 온프레미스 서버를 탭으로 바꿔 가며 등록한다 (처음에는 AWS).
 * 온프레미스 서버는 등록하자마자 1회용 토큰과 Agent 설치 명령을 보여 주고, 완료를 누르면 닫는다.
 */
export function AddConnectionDialog({ open, takenNames, onRefresh, onTokenIssued, onClose }: {
  open: boolean; takenNames: string[]; onRefresh: () => Promise<void>;
  /** 방금 발급한 Agent 토큰. 창을 닫은 뒤 표의 설치 안내에서도 같은 토큰을 보여 준다. */
  onTokenIssued: (id: string, token: AgentRegistrationToken) => void; onClose: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      // showModal은 첫 버튼(닫기)에 초점을 둔다. 바로 입력할 수 있게 첫 입력란으로 옮긴다.
      element.querySelector('input')?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);

  return <dialog ref={dialog} className="picker-dialog connection-dialog" aria-labelledby={titleId} onClose={onClose}
    onClick={(event) => { if (event.target === dialog.current) onClose(); }}>
    <div className="picker-dialog__body">
      {open && <AddConnectionBody titleId={titleId} takenNames={takenNames} onRefresh={onRefresh} onTokenIssued={onTokenIssued} onClose={onClose} />}
    </div>
  </dialog>;
}
