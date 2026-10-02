import { useEffect, useId, useState } from 'react';
import { changeProjectSubdomain, getProject, STATIC_SITE_PROFILE, type ProjectSummary } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { Marble } from '../../components/ui/Marble';
import { elapsed, hostOf, safeHttpUrl } from '../dashboard/format';
import { useI18n } from '../../i18n/I18nProvider';
import { ServerReason } from '../deployment-progress/ServerReason';
import type { Messages } from '../../i18n/ko';
import { AddressField } from './AddressField';
import { PLATFORM_DOMAIN, useSubdomainCheck } from './subdomain';

/** 주소 변경이 끝났는지 다시 읽는 간격 */
const POLL_MS = 3_000;

/** addressChange.error 는 "오류 코드\n상세". 아는 코드는 현재 언어 문구로 바꾼다. */
function failureText(error: string | null, t: Messages): { reason: string; detail: string | null } {
  const [code = '', ...rest] = (error ?? '').split('\n');
  return {
    reason: t.address.reasons[code] ?? t.address.unknownReason,
    detail: [code, rest.join('\n').trim()].filter(Boolean).join('\n') || null,
  };
}

/**
 * 프로젝트 설정 탭의 "주소" (#302). 새 주소를 입력하면 바로 사용 가능 여부를 보여 주고, 화면 안에서 한 번 더 확인한 뒤 바꾼다.
 * 서비스 중인 앱은 서버가 새 주소를 연결 · 확인하는 동안(changing) 진행 상태를 다시 읽고, 끝나면 결과를 보여 준다.
 */
export function AddressCard({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
  const { t } = useI18n();
  const copy = t.address;
  const titleId = useId();
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [value, setValue] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<unknown>(null);
  /** 이 화면에서 요청한 변경 — 끝나면 성공 · 실패를 보여 준다 */
  const [requested, setRequested] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    getProject(projectId).then(
      (loaded) => { if (!active) return; setProject(loaded); setValue(loaded.subdomain ?? ''); },
      (error) => { if (active) setLoadError(error); },
    );
    return () => { active = false; };
  }, [projectId]);

  const current = project?.subdomain ?? null;
  const check = useSubdomainCheck(value, current);
  const change = project?.addressChange ?? null;
  const changing = change?.status === 'changing';

  // 바꾸는 중이면 끝날 때까지 다시 읽는다
  useEffect(() => {
    if (!changing) return;
    let active = true;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      getProject(projectId).then((loaded) => {
        if (!active) return;
        setProject(loaded);
        if (loaded.addressChange?.status === 'succeeded') { setValue(loaded.subdomain ?? ''); onChanged(); }
      }, () => { /* 다음 차례에 다시 읽는다 */ });
    }, POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [changing, projectId, onChanged]);

  async function submit() {
    const next = value.trim().toLowerCase();
    setBusy(true);
    setRequestError(null);
    try {
      const updated = await changeProjectSubdomain(projectId, next);
      setProject(updated);
      setRequested(true);
      setNow(Date.now());
      setConfirming(false);
      if (updated.addressChange?.status === 'succeeded') onChanged();
    } catch (error) {
      setRequestError(error);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  let body;
  if (project === null) {
    body = loadError !== null
      ? <div className="notice error" role="alert"><ServerReason error={loadError} fallback={copy.loadError} /></div>
      : <p className="dashboard-status" role="status">{t.projects.loading}</p>;
  } else {
    const currentUrl = safeHttpUrl(project.publicUrl);
    const isStatic = project.live?.targetProfile === STATIC_SITE_PROFILE;
    const canSubmit = check.phase === 'available' && !busy && !changing && !isStatic;
    const next = value.trim().toLowerCase();
    body = <>
      <p>{copy.intro}</p>
      <p className="address-card__current">
        <span>{copy.currentLabel}</span>
        {currentUrl
          ? <a href={currentUrl} target="_blank" rel="noreferrer">{hostOf(currentUrl)}<span className="visually-hidden"> {t.dashboard.newTab}</span></a>
          : <code>{current}.{PLATFORM_DOMAIN}</code>}
      </p>

      {changing && change && <div className="delete-app__progress" role="status" aria-live="polite">
        <p className="delete-app__state"><Marble tone="running" size={12} /><strong>{copy.changingTitle}</strong>
          <span className="delete-app__time">{t.deleteApp.elapsed(elapsed(change.requestedAt, now))}</span></p>
        <p>{copy.changingCopy(`${change.to}.${PLATFORM_DOMAIN}`)}</p>
      </div>}
      {!changing && requested && change?.status === 'succeeded' && <div className="notice address-card__done" role="status">
        <Marble tone="success" size={12} /> <strong>{copy.succeededTitle}</strong> {copy.succeededCopy(`${change.to}.${PLATFORM_DOMAIN}`)}
      </div>}
      {!changing && change?.status === 'failed' && (() => {
        const { reason, detail } = failureText(change.error, t);
        return <div className="notice error" role="alert">
          <strong>{copy.failedTitle}</strong> {reason}
          <p className="delete-app__failed-copy">{copy.failedCopy(`${change.from}.${PLATFORM_DOMAIN}`)}</p>
          {detail && <details className="delete-app__detail"><summary>{copy.detail}</summary><pre>{detail}</pre></details>}
        </div>;
      })()}

      {isStatic
        ? <div className="notice" role="note">{copy.staticUnsupported}</div>
        : !changing && <form className="setup-form address-card__form" onSubmit={(event) => { event.preventDefault(); if (canSubmit) setConfirming(true); }}>
          <AddressField value={value} onChange={(input) => { setValue(input); setConfirming(false); setRequestError(null); }}
            check={check} disabled={busy} label={copy.newAddressLabel} emptyHint={copy.emptyHint} />
          {!confirming && <Keycap type="submit" disabled={!canSubmit}>{copy.button}</Keycap>}
        </form>}

      {confirming && !isStatic && <div className="notice address-card__confirm" role="alertdialog" aria-labelledby={`${titleId}-confirm`}>
        <strong id={`${titleId}-confirm`}>{copy.confirmTitle(`${current}.${PLATFORM_DOMAIN}`, `${next}.${PLATFORM_DOMAIN}`)}</strong>
        <p>{project.live ? copy.confirmCopyLive : copy.confirmCopy}</p>
        <div className="page-actions">
          <Keycap onClick={() => void submit()} disabled={busy}>{busy ? copy.requesting : copy.confirm}</Keycap>
          <Keycap variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>{copy.cancel}</Keycap>
        </div>
      </div>}

      {requestError !== null && <div className="notice error" role="alert">
        <strong>{copy.requestFailed}</strong>{' '}
        <ServerReason error={requestError} fallback={copy.requestFailed} known={copy.errors} />
      </div>}
    </>;
  }

  return <section className="setup-card address-card" aria-labelledby={titleId}>
    <div className="setup-card__head"><h2 id={titleId}>{copy.title}</h2></div>
    <div className="setup-card__body">{body}</div>
  </section>;
}
