import type { ReactNode } from 'react';
import { followAppLink, type Navigate } from '../../app/navigation';
import { Keycap } from '../../components/ui/Keycap';
import { StatusTape } from '../../components/ui/StatusTape';
import { useI18n } from '../../i18n/I18nProvider';
import { deploymentStatusView } from '../deployment-status/status-view';
import { displayProjectName, elapsed, hostOf, isStalled, relativeTime, safeHttpUrl } from './format';
import { MiniRail } from './MiniRail';
import type { DeploymentListItem } from './useDeploymentList';

function ExternalIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4 H20 V10" /><path d="M20 4 L11 13" /><path d="M18 14 V20 H4 V6 H10" />
  </svg>;
}

export function DeploymentRow({ deployment, now, onNavigate, extraAction }: { deployment: DeploymentListItem; now: number; onNavigate: Navigate; /** 기본 동작 옆에 붙이는 추가 동작 (예: 재배포) */ extraAction?: ReactNode }) {
  const { t } = useI18n();
  const view = deploymentStatusView(deployment.status);
  const stalled = isStalled(view.outcome === 'active', deployment.createdAt, now);
  const name = displayProjectName(deployment.projectName);
  const titleId = `deployment-${deployment.id}-title`;
  const progressPath = `/deployments/${encodeURIComponent(deployment.id)}`;
  const finishedAt = deployment.succeededAt ?? deployment.failedAt;
  const timing = view.outcome === 'active'
    ? `${relativeTime(deployment.createdAt, now, t)} · ${elapsed(deployment.createdAt, now)}`
    : finishedAt ? `${relativeTime(deployment.createdAt, now, t)} · ${elapsed(deployment.createdAt, Date.parse(finishedAt))}` : relativeTime(deployment.createdAt, now, t);
  const liveUrl = view.outcome === 'success' ? safeHttpUrl(deployment.publicUrl) : null;
  const context = <span className="visually-hidden"> {name}</span>;

  const action = view.outcome === 'active'
    ? <Keycap variant="secondary" href={progressPath} onClick={(event) => followAppLink(event, onNavigate)}>{stalled ? t.dashboard.details : t.dashboard.watch}{context}</Keycap>
    : liveUrl
      ? <Keycap href={liveUrl} target="_blank" rel="noreferrer" trailing={<ExternalIcon />}>{t.dashboard.open}{context}<span className="visually-hidden"> {t.dashboard.newTab}</span></Keycap>
      : view.outcome === 'success'
        ? <Keycap variant="secondary" href={`${progressPath}/result`} onClick={(event) => followAppLink(event, onNavigate)}>{t.dashboard.viewResult}{context}</Keycap>
        : <Keycap variant="secondary" href={progressPath} onClick={(event) => followAppLink(event, onNavigate)}>{view.outcome === 'failed' ? t.dashboard.viewCause : t.dashboard.details}{context}</Keycap>;

  return <article className={`deployment-row deployment-row--${view.outcome}`} aria-labelledby={titleId}>
    <div className="deployment-row__name">
      <h2 id={titleId} title={deployment.projectName}>{name}</h2>
      {liveUrl
        ? <a className="deployment-row__sub" href={liveUrl} target="_blank" rel="noreferrer">{hostOf(liveUrl)}</a>
        : <span className="deployment-row__sub">{t.dashboard.deploymentNo(deployment.id)}{deployment.sourceSha256 ? ` · ${deployment.sourceSha256.slice(0, 12)}` : ''}</span>}
    </div>
    <StatusTape tone={stalled ? 'waiting' : view.tone} className="deployment-row__tape">{stalled ? 'STALLED' : view.tape}</StatusTape>
    <MiniRail view={view} />
    <div className="deployment-row__stage">
      <span className={`deployment-row__stage-label is-${stalled ? 'stopped' : view.outcome}`}>{stalled ? t.dashboard.stalled : t.status.stage[view.stageKey]}</span>
      <span className="deployment-row__time">{timing}</span>
    </div>
    <div className="deployment-row__action">{extraAction}{action}</div>
  </article>;
}
