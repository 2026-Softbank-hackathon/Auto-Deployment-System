import { useId, useRef, useState } from 'react';
import { followAppLink, type Navigate } from '../app/navigation';
import { DeployKeycap } from '../components/ui/DeployKeycap';
import { Keycap } from '../components/ui/Keycap';
import { Koro } from '../components/ui/Koro';
import { StatusTape } from '../components/ui/StatusTape';
import { RedeployButton } from '../features/deployment-progress/RedeployButton';
import { DeploymentRow } from '../features/dashboard/DeploymentRow';
import { useDeploymentList, type DeploymentListItem } from '../features/dashboard/useDeploymentList';
import { displayProjectName, isStalled } from '../features/dashboard/format';
import { deploymentStatusView } from '../features/deployment-status/status-view';
import { errorMessage, useI18n } from '../i18n/I18nProvider';

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

function EmptyState({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useI18n();
  return <section className="dashboard-empty" aria-labelledby="empty-deployments-title">
    <SleepingRailScene />
    <h2 id="empty-deployments-title">{t.dashboard.emptyTitle}</h2>
    <p>{t.dashboard.emptyCopy}</p>
    <DeployKeycap size="lg" href="/deploy" onClick={(event) => followAppLink(event, onNavigate)}>{t.dashboard.emptyCta}</DeployKeycap>
  </section>;
}

function Counts({ items, now }: { items: DeploymentListItem[]; now: number }) {
  const { t } = useI18n();
  const outcomes = items.map((item) => {
    const outcome = deploymentStatusView(item.status).outcome;
    return isStalled(outcome === 'active', item.createdAt, now) ? 'stalled' : outcome;
  });
  const count = (outcome: string) => outcomes.filter((value) => value === outcome).length;
  return <div className="dashboard-counts">
    <StatusTape tone="running">{t.dashboard.countActive(count('active'))}</StatusTape>
    <StatusTape tone="success">{t.dashboard.countSuccess(count('success'))}</StatusTape>
    <StatusTape tone="failed">{t.dashboard.countFailed(count('failed'))}</StatusTape>
    {count('stalled') > 0 && <StatusTape tone="waiting">{t.dashboard.countStalled(count('stalled'))}</StatusTape>}
    <span className="dashboard-counts__note">{t.dashboard.countBasis(items.length)}</span>
  </div>;
}

const PAGE_SIZE = 10;
type StatusFilter = 'all' | 'active' | 'success' | 'failed';
const statusFilters: readonly StatusFilter[] = ['all', 'active', 'success', 'failed'];

/** 검색어가 프로젝트 이름 · 배포 번호(#12 또는 12) · 공개 주소 중 하나에 들어 있는지. 대소문자는 가리지 않는다. */
function matchesQuery(item: DeploymentListItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [displayProjectName(item.projectName), item.projectName, `#${item.id}`, item.publicUrl ?? ''].join(' ').toLowerCase();
  return haystack.includes(needle);
}

/** 실패에는 취소 · 거절(멈춤)도 같이 묶는다. 끝났지만 성공하지 못한 배포를 한 번에 찾기 위해서다. */
function matchesStatus(item: DeploymentListItem, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  const outcome = deploymentStatusView(item.status).outcome;
  return filter === 'failed' ? outcome === 'failed' || outcome === 'stopped' : outcome === filter;
}

export function DashboardPage({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useI18n();
  const { state, retry } = useDeploymentList();
  const hasItems = state.phase === 'ready' && state.items.length > 0;
  const searchId = useId();
  const filterId = useId();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  // 페이지를 넘기면 목록 맨 위(검색 줄)로 올려서, 아래쪽 페이지 버튼 근처에 머물지 않게 한다.
  const toolsRef = useRef<HTMLDivElement>(null);
  const goToPage = (next: number) => { setPage(next); toolsRef.current?.scrollIntoView({ block: 'start' }); };

  // 불러온 목록 안에서 찾는다 (전역 검색 API가 없다). 10초마다 목록이 갱신돼도 검색어 · 페이지는 유지한다.
  const filtered = state.phase === 'ready' ? state.items.filter((item) => matchesQuery(item, query) && matchesStatus(item, statusFilter)) : [];
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const first = (currentPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(first, first + PAGE_SIZE);
  const filtering = query.trim() !== '' || statusFilter !== 'all';

  return <>
    <div className="page-head">
      <div><h1>{t.dashboard.title}</h1><p>{t.dashboard.description}</p></div>
      {hasItems && <DeployKeycap href="/deploy" onClick={(event) => followAppLink(event, onNavigate)}>{t.dashboard.newDeploy}</DeployKeycap>}
    </div>

    {state.phase === 'loading' && <p className="dashboard-status" role="status">{t.dashboard.loading}</p>}

    {state.phase === 'error' && <div className="notice error dashboard-error" role="alert">
      <strong>{t.dashboard.loadError}</strong><br />{errorMessage(state.error, t, t.errors.listFailed)}
      <div className="page-actions"><Keycap variant="secondary" onClick={retry}>{t.dashboard.retry}</Keycap></div>
    </div>}

    {state.phase === 'ready' && state.items.length === 0 && <EmptyState onNavigate={onNavigate} />}

    {state.phase === 'ready' && state.items.length > 0 && <>
      <Counts items={state.items} now={state.loadedAt} />
      {state.partialFailures > 0 && <p className="dashboard-status">{t.dashboard.partialFailures(state.partialFailures)}</p>}

      <div className="dashboard-tools" role="search" ref={toolsRef}>
        <div className="aws-key-form__field dashboard-tools__search">
          <label htmlFor={searchId}>{t.dashboard.searchLabel}</label>
          <input id={searchId} type="search" value={query} placeholder={t.dashboard.searchPlaceholder} autoComplete="off" spellCheck={false}
            onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
        </div>
        <div className="aws-key-form__field">
          <label htmlFor={filterId}>{t.dashboard.filterLabel}</label>
          <select id={filterId} value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as StatusFilter); setPage(1); }}>
            {statusFilters.map((filter) => <option key={filter} value={filter}>{t.dashboard.filters[filter]}</option>)}
          </select>
        </div>
      </div>

      <p className="dashboard-status" role="status" aria-live="polite">
        {filtered.length === 0 ? t.dashboard.noMatches : t.dashboard.showing(filtered.length, first + 1, first + visible.length)}
        {filtering && <> <button type="button" className="dashboard-tools__clear" onClick={() => { setQuery(''); setStatusFilter('all'); setPage(1); }}>{t.dashboard.clearSearch}</button></>}
      </p>

      {visible.length > 0 && <section className="deployment-list" aria-label={t.dashboard.listLabel}>
        {visible.map((deployment) => <DeploymentRow key={deployment.id} deployment={deployment} now={state.loadedAt} onNavigate={onNavigate}
          extraAction={['failed', 'stopped'].includes(deploymentStatusView(deployment.status).outcome)
            ? <RedeployButton compact variant="ghost" deploymentId={deployment.id} onStarted={(id) => onNavigate(`/deployments/${encodeURIComponent(id)}`)} /> : undefined} />)}
      </section>}

      {pageCount > 1 && <nav className="pager" aria-label={t.dashboard.pagerLabel}>
        <Keycap variant="secondary" disabled={currentPage <= 1} onClick={() => goToPage(currentPage - 1)}>{t.dashboard.prevPage}</Keycap>
        <span className="pager__status" aria-current="page">{t.dashboard.pageOf(currentPage, pageCount)}</span>
        <Keycap variant="secondary" disabled={currentPage >= pageCount} onClick={() => goToPage(currentPage + 1)}>{t.dashboard.nextPage}</Keycap>
      </nav>}
    </>}
  </>;
}
