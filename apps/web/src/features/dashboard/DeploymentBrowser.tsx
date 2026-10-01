import { useId, useRef, useState, type ReactNode } from 'react';
import type { Navigate } from '../../app/navigation';
import { Keycap } from '../../components/ui/Keycap';
import { useI18n } from '../../i18n/I18nProvider';
import { deploymentStatusView } from '../deployment-status/status-view';
import { DeploymentRow } from './DeploymentRow';
import { displayProjectName } from './format';
import type { DeploymentListItem } from './useDeploymentList';

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

/**
 * 배포 목록 + 검색 · 상태 필터 · 페이지 나누기. 배포 현황(전체)과 프로젝트 상세(한 프로젝트)가 같이 쓴다.
 * 받은 목록 안에서 찾는다 (전역 검색 API가 없다). 목록이 다시 들어와도 검색어 · 페이지는 유지한다.
 */
export function DeploymentBrowser({ items, now, onNavigate, extraAction, searchPlaceholder }: {
  items: DeploymentListItem[]; now: number; onNavigate: Navigate;
  /** 행마다 기본 동작 옆에 붙일 추가 동작 (예: 재배포) */
  extraAction?: (deployment: DeploymentListItem) => ReactNode;
  searchPlaceholder: string;
}) {
  const { t } = useI18n();
  const searchId = useId();
  const filterId = useId();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  // 페이지를 넘기면 목록 맨 위(검색 줄)로 올려서, 아래쪽 페이지 버튼 근처에 머물지 않게 한다.
  const toolsRef = useRef<HTMLDivElement>(null);
  const goToPage = (next: number) => { setPage(next); toolsRef.current?.scrollIntoView({ block: 'start' }); };

  const filtered = items.filter((item) => matchesQuery(item, query) && matchesStatus(item, statusFilter));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const first = (currentPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(first, first + PAGE_SIZE);
  const filtering = query.trim() !== '' || statusFilter !== 'all';

  return <>
    <div className="dashboard-tools" role="search" ref={toolsRef}>
      <div className="aws-key-form__field dashboard-tools__search">
        <label htmlFor={searchId}>{t.dashboard.searchLabel}</label>
        <input id={searchId} type="search" value={query} placeholder={searchPlaceholder} autoComplete="off" spellCheck={false}
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
      {visible.map((deployment) => <DeploymentRow key={deployment.id} deployment={deployment} now={now} onNavigate={onNavigate} extraAction={extraAction?.(deployment)} />)}
    </section>}

    {pageCount > 1 && <nav className="pager" aria-label={t.dashboard.pagerLabel}>
      <Keycap variant="secondary" disabled={currentPage <= 1} onClick={() => goToPage(currentPage - 1)}>{t.dashboard.prevPage}</Keycap>
      <span className="pager__status" aria-current="page">{t.dashboard.pageOf(currentPage, pageCount)}</span>
      <Keycap variant="secondary" disabled={currentPage >= pageCount} onClick={() => goToPage(currentPage + 1)}>{t.dashboard.nextPage}</Keycap>
    </nav>}
  </>;
}
