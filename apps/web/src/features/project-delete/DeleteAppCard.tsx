import { useEffect, useId, useRef, useState } from 'react';
import { DeploymentApiError, deleteProject, getProject, type ProjectDeletion, type ProjectDeletionWarning } from '../../api/deployment-api';
import { followAppLink, type Navigate } from '../../app/navigation';
import { Keycap } from '../../components/ui/Keycap';
import { Marble } from '../../components/ui/Marble';
import { elapsed } from '../dashboard/format';
import { useI18n } from '../../i18n/I18nProvider';
import { ServerReason } from '../deployment-progress/ServerReason';
import type { Messages } from '../../i18n/ko';

/** 삭제가 끝났는지(앱이 사라졌는지) 다시 읽는 간격 */
const POLL_MS = 4_000;

type State =
  | { phase: 'loading' }
  | { phase: 'idle' }
  | { phase: 'requesting' }
  | { phase: 'deleting'; deletion: ProjectDeletion }
  | { phase: 'failed'; deletion: ProjectDeletion }
  | { phase: 'deleted'; warnings: ProjectDeletionWarning[] };

function isGone(error: unknown): boolean {
  return error instanceof DeploymentApiError && error.status === 404;
}

/** deletion.error 는 "오류 코드\n상세". 아는 코드는 현재 언어 문구로 바꾼다. */
function failureText(error: string | null, t: Messages): { reason: string; detail: string | null } {
  const [code = '', ...rest] = (error ?? '').split('\n');
  const detail = rest.join('\n').trim();
  return {
    reason: t.deleteApp.reasons[code] ?? t.deleteApp.unknownReason,
    detail: [code, detail].filter(Boolean).join('\n') || null,
  };
}

/**
 * 프로젝트 설정 탭의 앱 삭제 영역 (#249). 앱 이름을 그대로 입력해야 버튼이 켜진다.
 * 삭제는 서버가 이어서 진행하므로(AWS 리소스 정리에 몇 분), 끝날 때까지 상태를 다시 읽고 앱이 사라지면 결과를 보여 준다.
 */
export function DeleteAppCard({ projectId, appName, onDeleted, onNavigate }: {
  projectId: string; appName: string;
  /** 삭제가 끝난 뒤 대시보드로 나갈 때 — 앱 목록을 다시 읽게 한다 (바로 다시 읽으면 이 화면이 "찾지 못함"으로 바뀐다) */
  onDeleted: () => void;
  onNavigate: Navigate;
}) {
  const { t } = useI18n();
  const copy = t.deleteApp;
  const inputId = useId();
  const titleId = useId();
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [typed, setTyped] = useState('');
  const [requestError, setRequestError] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());

  // 처음 들어왔을 때 이미 삭제 중이거나 실패한 앱이면 그 상태부터 보여 준다.
  useEffect(() => {
    let active = true;
    getProject(projectId).then(
      (project) => {
        if (!active) return;
        const { deletion } = project;
        setState(deletion ? { phase: deletion.status, deletion } : { phase: 'idle' });
      },
      (error) => { if (active) setState(isGone(error) ? { phase: 'deleted', warnings: [] } : { phase: 'idle' }); },
    );
    return () => { active = false; };
  }, [projectId]);

  // 삭제 중이면 끝날 때까지 다시 읽는다. 앱이 사라지면(404) 삭제가 끝난 것이다.
  // 끝나면 응답에 경고가 없으므로, 삭제 중에 받은 경고를 결과 화면에 그대로 보여 준다.
  const deleting = state.phase === 'deleting';
  const warningsRef = useRef<ProjectDeletionWarning[]>([]);
  if (state.phase === 'deleting' || state.phase === 'failed') warningsRef.current = state.deletion.warnings;
  useEffect(() => {
    if (!deleting) return;
    let active = true;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      getProject(projectId).then(
        (project) => {
          if (!active || !project.deletion) return;
          const deletion = project.deletion;
          setState({ phase: deletion.status, deletion });
        },
        (error) => {
          if (!active || !isGone(error)) return;
          setState({ phase: 'deleted', warnings: warningsRef.current });
        },
      );
    }, POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [deleting, projectId]);

  async function start() {
    setRequestError(null);
    setState({ phase: 'requesting' });
    try {
      const deletion = await deleteProject(projectId);
      setNow(Date.now());
      setState({ phase: 'deleting', deletion });
    } catch (error) {
      if (isGone(error)) { setState({ phase: 'deleted', warnings: warningsRef.current }); return; }
      setRequestError(error);
      setState({ phase: 'idle' });
    }
  }

  const onpremWarning = (list: ProjectDeletionWarning[]) => list.includes('ONPREM_MANUAL_CLEANUP')
    ? <div className="notice delete-app__warning" role="note">{copy.onpremWarning}</div>
    : null;

  let body;
  if (state.phase === 'loading') {
    body = <p className="dashboard-status" role="status">{t.projects.loading}</p>;
  } else if (state.phase === 'deleting') {
    body = <div className="delete-app__progress" role="status" aria-live="polite">
      <p className="delete-app__state"><Marble tone="running" size={12} /><strong>{copy.deletingTitle}</strong>
        <span className="delete-app__time">{copy.elapsed(elapsed(state.deletion.requestedAt, now))}</span></p>
      <p>{copy.deletingCopy}</p>
      {onpremWarning(state.deletion.warnings)}
    </div>;
  } else if (state.phase === 'failed') {
    const { reason, detail } = failureText(state.deletion.error, t);
    body = <>
      <div className="notice error" role="alert">
        <strong>{copy.failedTitle}</strong> {reason}
        <p className="delete-app__failed-copy">{copy.failedCopy}</p>
        {detail && <details className="delete-app__detail"><summary>{copy.detail}</summary><pre>{detail}</pre></details>}
      </div>
      {onpremWarning(state.deletion.warnings)}
      <div className="page-actions"><Keycap variant="secondary" onClick={() => void start()}>{copy.retry}</Keycap></div>
    </>;
  } else if (state.phase === 'deleted') {
    body = <div className="delete-app__done" role="status">
      <p className="delete-app__state"><Marble tone="success" size={12} /><strong>{copy.deletedTitle}</strong></p>
      <p>{copy.deletedCopy}</p>
      {onpremWarning(state.warnings)}
      <div className="page-actions">
        <Keycap href="/" onClick={(event) => { onDeleted(); followAppLink(event, onNavigate); }}>{copy.toDashboard}</Keycap>
      </div>
    </div>;
  } else {
    const confirmed = typed.trim() === appName;
    const busy = state.phase === 'requesting';
    body = <>
      <p>{copy.intro}</p>
      <ul className="delete-app__list">{copy.removes.map((item) => <li key={item}>{item}</li>)}</ul>
      <p>{copy.keeps}</p>
      <p className="delete-app__note">{copy.onpremNote}</p>
      <form className="setup-form" onSubmit={(event) => { event.preventDefault(); if (confirmed && !busy) void start(); }}>
        <div className="aws-key-form__field">
          <label htmlFor={inputId}>{copy.confirmLabel(appName)}</label>
          <input id={inputId} value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false}
            placeholder={appName} disabled={busy} />
        </div>
        <Keycap type="submit" className="delete-app__button" disabled={!confirmed || busy}>{busy ? copy.requesting : copy.button}</Keycap>
      </form>
      {requestError !== null && <div className="notice error" role="alert">
        <strong>{copy.requestFailed}</strong>{' '}
        <ServerReason error={requestError} fallback={copy.requestFailed} known={copy.errors} />
      </div>}
    </>;
  }

  return <section className="setup-card delete-app" aria-labelledby={titleId}>
    <div className="setup-card__head"><h2 id={titleId}>{copy.title}</h2></div>
    <div className="setup-card__body">{body}</div>
  </section>;
}
