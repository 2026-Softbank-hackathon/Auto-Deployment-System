import { useEffect, useId, useRef, useState } from 'react';
import type { ProjectSummary } from '../api/deployment-api';
import { followAppLink, type Navigate } from '../app/navigation';
import { DeployKeycap } from '../components/ui/DeployKeycap';
import { Keycap } from '../components/ui/Keycap';
import { Koro } from '../components/ui/Koro';
import { Marble } from '../components/ui/Marble';
import { StatusTape } from '../components/ui/StatusTape';
import { displayProjectName, elapsed, hostOf, isStalled, relativeTime, safeHttpUrl } from '../features/dashboard/format';
import { MiniRail } from '../features/dashboard/MiniRail';
import { latestActive, LIVE_REFRESH_MS, useProjectList } from '../features/dashboard/useProjectList';
import { deploymentStatusView } from '../features/deployment-status/status-view';
import { errorMessage, useI18n } from '../i18n/I18nProvider';

const PAGE_SIZE = 9;

function SleepingRailScene() {
  const { t } = useI18n();
  return <svg className="empty-scene" width="560" height="150" viewBox="0 0 560 150" role="img" aria-label={t.dashboard.emptyScene}>
    <line className="empty-scene__floor" x1="20" y1="142" x2="540" y2="142" />
    <rect className="empty-scene__pad-base" x="20" y="96" width="110" height="40" rx="12" />
    <rect className="empty-scene__pad" x="20" y="88" width="110" height="40" rx="12" />
    <path className="empty-scene__rail" d="M130 112 L480 112" />
    <circle className="empty-scene__stop" cx="220" cy="112" r="6" />
    <circle className="empty-scene__stop" cx="310" cy="112" r="6" />
    <circle className="empty-scene__stop" cx="400" cy="112" r="6" />
    <path className="empty-scene__cup" d="M486 98 H540 V110 A27 24 0 0 1 486 110 Z" />
    <ellipse className="empty-scene__shadow" cx="75" cy="88" rx="26" ry="4" />
    <Koro mood="sleepy" size={64} x={43} y={24} />
    <text className="empty-scene__z" x="104" y="30" fontSize="14">z</text>
    <text className="empty-scene__z empty-scene__z--small" x="116" y="18" fontSize="11">z</text>
  </svg>;
}

function ExternalIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4 H20 V10" /><path d="M20 4 L11 13" /><path d="M18 14 V20 H4 V6 H10" />
  </svg>;
}

function CopyUrlButton({ url, appName }: { url: string; appName: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try { await navigator.clipboard.writeText(url); setCopied(true); } catch { setCopied(false); }
  }
  return <Keycap variant="ghost" onClick={() => void copy()}>
    {copied ? t.setup.copied : t.dashboard.copyUrl}<span className="visually-hidden"> {appName}</span>
  </Keycap>;
}

/** 앱 한 개: 지금 어디서 서비스 중인지 · 공개 주소 · 최근 배포 */
function AppCard({ project, now, onDeploy, onNavigate }: { project: ProjectSummary; now: number; onDeploy: () => void; onNavigate: Navigate }) {
  const { t } = useI18n();
  const copy = t.dashboard;
  const name = displayProjectName(project.name);
  const titleId = `app-${project.id}-title`;
  const detailPath = `/projects/${encodeURIComponent(project.id)}`;
  const { live, latest } = project;
  const liveUrl = safeHttpUrl(live?.publicUrl ?? null);
  const where = live
    ? copy.where[live.environmentType ?? 'unknown']
    : latest ? copy.where.notLive : copy.where.never;
  const context = <span className="visually-hidden"> {name}</span>;
  const link = (path: string, label: string) => <a href={path} onClick={(event) => followAppLink(event, onNavigate)}>{label}{context}</a>;

  // 최근 배포가 지금 서비스 중인 배포와 같으면 위쪽 서비스 줄이 이미 보여 주므로 따로 적지 않는다.
  const latestRow = (() => {
    if (!latest || latest.deploymentId === live?.deploymentId) return null;
    const view = deploymentStatusView(latest.status);
    const stalled = isStalled(view.outcome === 'active', latest.createdAt, now);
    const progressPath = `/deployments/${encodeURIComponent(latest.deploymentId)}`;
    if (view.outcome === 'active' && !stalled) {
      return <div className="app-card__latest is-active">
        <MiniRail view={view} />
        <div className="app-card__latest-line">
          <span className="app-card__stage is-active">{t.status.stage[view.stageKey]}</span>
          <span className="app-card__time">{elapsed(latest.createdAt, now)}</span>
          {link(progressPath, copy.watch)}
        </div>
      </div>;
    }
    const outcome = stalled ? 'stopped' : view.outcome;
    return <div className="app-card__latest">
      <div className="app-card__latest-line">
        <Marble tone={stalled ? 'waiting' : view.tone} size={12} />
        <span className={`app-card__stage is-${outcome}`}>{copy.latestLabel} · {stalled ? copy.stalled : t.status.stage[view.stageKey]}</span>
        <span className="app-card__time">{relativeTime(latest.createdAt, now, t)}</span>
        {view.outcome === 'failed' ? link(`${progressPath}/failure`, copy.viewCause) : link(progressPath, copy.details)}
      </div>
    </div>;
  })();

  // 삭제 요청한 앱 (#249): 삭제 중이면 정리 중이라고만, 실패하면 이유를 보러 설정 탭으로. 삭제가 끝나면 목록에서 빠진다.
  const { deletion } = project;
  if (deletion) {
    const settingsPath = `${detailPath}/settings`;
    const failed = deletion.status === 'failed';
    return <li className={`app-card is-deleting ${failed ? 'is-delete-failed' : ''}`} aria-labelledby={titleId}>
      <div className="app-card__head">
        <h2 id={titleId} title={project.name}><a href={detailPath} onClick={(event) => followAppLink(event, onNavigate)}>{name}</a></h2>
        <StatusTape tone={failed ? 'failed' : 'running'}>{failed ? copy.deleteFailed : copy.deleting}</StatusTape>
      </div>
      <p className={failed ? 'app-card__delete-error' : 'app-card__muted'}>
        {failed ? copy.deleteFailedCopy : copy.deletingCopy}
        {!failed && <span className="app-card__time"> {elapsed(deletion.requestedAt, now)}</span>}
      </p>
      <div className="app-card__actions">
        <Keycap variant="secondary" href={settingsPath} onClick={(event) => followAppLink(event, onNavigate)}>{failed ? copy.retryDelete : copy.appDetail}{context}</Keycap>
      </div>
    </li>;
  }

  return <li className={`app-card ${latestActive(project, now) ? 'is-active' : ''}`} aria-labelledby={titleId}>
    <div className="app-card__head">
      <h2 id={titleId} title={project.name}><a href={detailPath} onClick={(event) => followAppLink(event, onNavigate)}>{name}</a></h2>
      <StatusTape tone={live ? 'success' : 'waiting'}><span title={live?.environmentName ?? undefined}>{where}</span></StatusTape>
    </div>

    {live
      ? <div className="app-card__live">
        {liveUrl
          ? <div className="app-card__url">
            <a href={liveUrl} target="_blank" rel="noreferrer">{hostOf(liveUrl)} <ExternalIcon /><span className="visually-hidden"> {t.dashboard.newTab}</span></a>
            <CopyUrlButton url={liveUrl} appName={name} />
          </div>
          : <p className="app-card__muted">{copy.noPublicUrl}</p>}
        <p className="app-card__muted">
          <a href={`/deployments/${encodeURIComponent(live.deploymentId)}/result`} onClick={(event) => followAppLink(event, onNavigate)}>{copy.deploymentNo(live.deploymentId)}</a>
          {live.environmentName ? ` · ${live.environmentName}` : ''}
          {live.succeededAt ? ` · ${relativeTime(live.succeededAt, now, t)}` : ''}
        </p>
      </div>
      : !latest && <p className="app-card__muted">{copy.neverDeployed}</p>}

    {latestRow}

    <div className="app-card__actions">
      <Keycap variant="secondary" href={detailPath} onClick={(event) => followAppLink(event, onNavigate)}>{copy.appDetail}{context}</Keycap>
      <Keycap onClick={onDeploy}>{copy.deployApp}{context}</Keycap>
    </div>
  </li>;
}

function Counts({ projects: all, now }: { projects: ProjectSummary[]; now: number }) {
  const { t } = useI18n();
  // 삭제를 요청한 앱은 세지 않는다 (#249)
  const projects = all.filter((project) => !project.deletion);
  const latestOutcome = (project: ProjectSummary) => project.latest ? deploymentStatusView(project.latest.status).outcome : null;
  const active = projects.filter((project) => latestActive(project, now)).length;
  const stalled = projects.filter((project) => project.latest && isStalled(latestOutcome(project) === 'active', project.latest.createdAt, now)).length;
  const live = projects.filter((project) => project.live !== null).length;
  const failed = projects.filter((project) => latestOutcome(project) === 'failed').length;
  return <div className="dashboard-counts">
    <StatusTape tone="running">{t.dashboard.countActive(active)}</StatusTape>
    <StatusTape tone="success">{t.dashboard.countLive(live)}</StatusTape>
    <StatusTape tone="failed">{t.dashboard.countFailed(failed)}</StatusTape>
    {stalled > 0 && <StatusTape tone="waiting">{t.dashboard.countStalled(stalled)}</StatusTape>}
    <span className="dashboard-counts__note">{t.dashboard.countBasis(projects.length)}</span>
  </div>;
}

/**
 * 대시보드 (#219): 앱(프로젝트)마다 지금 어디서 서비스 중인지와 최근 배포를 카드로 본다.
 * GET /projects 한 번으로 그린다 (항목에 live · latest가 들어 있다). 배포 한 건 한 건의 내역은 프로젝트 상세에서 본다.
 */
export function DashboardPage({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useI18n();
  const copy = t.dashboard;
  // 보고 있는 동안 계속 다시 읽는다 — 서비스 위치는 서버의 project.live 를 그대로 따른다 (자동 전환 #349)
  const { state, retry } = useProjectList(LIVE_REFRESH_MS);
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const toolsRef = useRef<HTMLDivElement>(null);
  const goToPage = (next: number) => { setPage(next); toolsRef.current?.scrollIntoView({ block: 'start' }); };

  /** 그 앱을 골라 둔 채로 간단 배포로 간다. */
  const deploy = (projectId: string) => onNavigate(`/deploy?project=${encodeURIComponent(projectId)}`);

  const hasProjects = state.phase === 'ready' && state.projects.length > 0;
  const head = <div className="page-head">
    <div><h1>{copy.title}</h1><p>{copy.description}</p></div>
    {hasProjects && <div className="page-head__actions">
      <DeployKeycap href="/deploy" onClick={(event) => followAppLink(event, onNavigate)}>{copy.newDeploy}</DeployKeycap>
    </div>}
  </div>;

  if (state.phase === 'loading') return <>{head}<p className="dashboard-status" role="status">{copy.appsLoading}</p></>;
  if (state.phase === 'error') return <>{head}<div className="notice error dashboard-error" role="alert">
    <strong>{copy.appsLoadError}</strong><br />{errorMessage(state.error, t, t.errors.listFailed)}
    <div className="page-actions"><Keycap variant="secondary" onClick={retry}>{copy.retry}</Keycap></div>
  </div></>;

  // 등록한 앱이 하나도 없으면 간단 배포로 안내한다. 앱은 첫 배포 때 ZIP 이름으로 만들어진다.
  if (state.projects.length === 0) return <>{head}<section className="dashboard-empty" aria-labelledby="empty-apps-title">
    <SleepingRailScene />
    <h2 id="empty-apps-title">{copy.emptyTitle}</h2>
    <p>{copy.emptyCopy}</p>
    <DeployKeycap size="lg" href="/deploy" onClick={(event) => followAppLink(event, onNavigate)}>{copy.newDeploy}</DeployKeycap>
  </section></>;

  const needle = query.trim().toLowerCase();
  const filtered = state.projects.filter((project) => needle === '' || displayProjectName(project.name).toLowerCase().includes(needle) || project.name.toLowerCase().includes(needle));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const first = (currentPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(first, first + PAGE_SIZE);
  return <>
    {head}
    <Counts projects={state.projects} now={state.loadedAt} />
    <div className="dashboard-tools" role="search" ref={toolsRef}>
      <div className="aws-key-form__field dashboard-tools__search">
        <label htmlFor={searchId}>{copy.searchLabel}</label>
        <input id={searchId} type="search" value={query} placeholder={copy.searchName} autoComplete="off" spellCheck={false}
          onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
      </div>
    </div>
    <p className="dashboard-status" role="status" aria-live="polite">
      {filtered.length === 0 ? copy.appsNoMatches : copy.appsShowing(filtered.length, first + 1, first + visible.length)}
      {needle !== '' && <> <button type="button" className="dashboard-tools__clear" onClick={() => { setQuery(''); setPage(1); }}>{copy.clearSearch}</button></>}
    </p>
    {visible.length > 0 && <ul className="app-list" aria-label={copy.appsLabel}>
      {visible.map((project) => <AppCard key={project.id} project={project} now={state.loadedAt}
        onDeploy={() => deploy(project.id)} onNavigate={onNavigate} />)}
    </ul>}
    {pageCount > 1 && <nav className="pager" aria-label={copy.appsPagerLabel}>
      <Keycap variant="secondary" disabled={currentPage <= 1} onClick={() => goToPage(currentPage - 1)}>{copy.prevPage}</Keycap>
      <span className="pager__status" aria-current="page">{copy.pageOf(currentPage, pageCount)}</span>
      <Keycap variant="secondary" disabled={currentPage >= pageCount} onClick={() => goToPage(currentPage + 1)}>{copy.nextPage}</Keycap>
    </nav>}
  </>;
}
