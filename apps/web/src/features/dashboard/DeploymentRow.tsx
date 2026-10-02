import type { ReactNode } from 'react';
import { SERVERLESS_PROFILE, STATIC_SITE_PROFILE } from '../../api/deployment-api';
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

/** 배포한 곳의 작은 그림: AWS는 구름, 온프레미스는 서버 */
export function EnvironmentIcon({ type }: { type: 'aws' | 'onprem' }) {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {type === 'aws'
      ? <path d="M7 18 H17.5 A4 4 0 0 0 17.5 10 A6 6 0 0 0 6 11 A3.5 3.5 0 0 0 7 18 Z" />
      : <><rect x="4" y="4" width="16" height="7" rx="1.5" /><rect x="4" y="13" width="16" height="7" rx="1.5" /><path d="M8 7.5 H8.01 M8 16.5 H8.01" /></>}
  </svg>;
}

export function DeploymentRow({ deployment, now, onNavigate, menu }: { deployment: DeploymentListItem; now: number; onNavigate: Navigate; /** 기본 동작 옆의 "⋯" 메뉴 */ menu?: ReactNode }) {
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
  // 프로젝트 주소는 하나라서, 지금 서비스 중인 배포만 LIVE이고 주소로 연다. 나머지 성공 배포는 이전 버전이다.
  const previous = view.outcome === 'success' && !deployment.isLive;
  const liveUrl = view.outcome === 'success' && deployment.isLive ? safeHttpUrl(deployment.publicUrl) : null;
  const environment = deployment.environmentType;
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
    <div className="deployment-row__status">
      <StatusTape tone={stalled ? 'waiting' : view.tone} className={previous ? 'status-tape--quiet' : ''}>{stalled ? 'STALLED' : previous ? t.versions.previous : view.tape}</StatusTape>
      {environment && <span className="deployment-row__env" title={deployment.environmentName ?? undefined}>
        <EnvironmentIcon type={environment} />{t.deploy.targets[environment]}
      </span>}
      {deployment.targetProfile === SERVERLESS_PROFILE && <span className="serverless-badge">{t.deploy.serverlessBadge}</span>}
      {deployment.targetProfile === STATIC_SITE_PROFILE && <span className="static-site-badge" title={t.run.staticSite.aws}>{t.run.staticSite.badge}</span>}
    </div>
    <MiniRail view={view} />
    <div className="deployment-row__stage">
      <span className={`deployment-row__stage-label is-${stalled ? 'stopped' : view.outcome}`}>{stalled ? t.dashboard.stalled : t.status.stage[view.stageKey]}</span>
      <span className="deployment-row__time">{timing}</span>
    </div>
    <div className="deployment-row__action">{action}{menu}</div>
  </article>;
}
