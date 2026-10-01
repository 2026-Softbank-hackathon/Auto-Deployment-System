import { useId, useRef, useState } from 'react';
import { redeployDeployment } from '../../api/deployment-api';
import type { Navigate } from '../../app/navigation';
import { Keycap } from '../../components/ui/Keycap';
import { serverReasonText, useI18n } from '../../i18n/I18nProvider';
import { deploymentStatusView } from '../deployment-status/status-view';
import { DeploymentRow } from './DeploymentRow';
import { RowMenu, type RowMenuItem } from './RowMenu';
import { displayProjectName, isStalled } from './format';
import type { DeploymentListItem } from './useDeploymentList';

/** 환경을 잡고 있는 상태 (서버의 재배포 락 검사와 같은 목록). 이 상태의 배포가 있으면 같은 환경으로는 재배포할 수 없다. */
const LOCKING_STATUSES = new Set(['queued', 'building', 'planning', 'awaiting_plan_approval', 'provisioning', 'deploying', 'verifying']);
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
 *
 * 행마다 "⋯" 메뉴가 있고, 끝난 배포(성공 · 실패 · 중단)는 거기서 재배포한다.
 */
export function DeploymentBrowser({ items, now, onNavigate, searchPlaceholder }: {
  items: DeploymentListItem[]; now: number; onNavigate: Navigate;
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

  const finished = (item: DeploymentListItem) => deploymentStatusView(item.status).outcome !== 'active';
  // 같은 프로젝트에 진행 중인 배포가 있으면 재배포할 수 없다. 서버도 환경을 잡고 있는 배포가 있으면
  // 재배포를 거절한다 (apps/api deployment-service redeploy: DEPLOYMENT_LOCKED). 눌러 보고 실패하지 않도록 미리 막는다.
  // 2시간 넘게 멈춘 배포는 진행 중으로 치지 않지만, 환경을 잡고 있는 상태면 서버가 거절하므로 그대로 막는다.
  const blocked = (item: DeploymentListItem) => items.some((other) => other.id !== item.id && other.projectName === item.projectName
    && !finished(other) && (LOCKING_STATUSES.has(other.status) || !isStalled(true, other.createdAt, now)));

  const [starting, setStarting] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ id: string; reason: string } | null>(null);
  async function redeploy(item: DeploymentListItem) {
    if (starting) return;
    setStarting(item.id);
    setFailure(null);
    try {
      const created = await redeployDeployment(item.id);
      onNavigate(`/deployments/${encodeURIComponent(created.deploymentId)}`);
    } catch (error) {
      setFailure({ id: item.id, reason: serverReasonText(error, t, t.redeploy.failed) });
      setStarting(null);
    }
  }

  function menuItems(item: DeploymentListItem): RowMenuItem[] {
    const path = `/deployments/${encodeURIComponent(item.id)}`;
    const outcome = deploymentStatusView(item.status).outcome;
    return [
      ...(finished(item) ? [{ key: 'redeploy', label: starting === item.id ? t.redeploy.starting : t.redeploy.button, onSelect: () => void redeploy(item), disabledReason: blocked(item) ? t.redeploy.blocked : undefined }] : []),
      { key: 'progress', label: t.dashboard.menuProgress, href: path },
      ...(outcome === 'success' ? [{ key: 'result', label: t.dashboard.viewResult, href: `${path}/result` }] : []),
    ];
  }

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

    {failure && <div className="notice error" role="alert"><strong>{t.dashboard.deploymentNo(failure.id)} — {t.redeploy.failed}</strong><br />{failure.reason}</div>}

    <p className="dashboard-status" role="status" aria-live="polite">
      {filtered.length === 0 ? t.dashboard.noMatches : t.dashboard.showing(filtered.length, first + 1, first + visible.length)}
      {filtering && <> <button type="button" className="dashboard-tools__clear" onClick={() => { setQuery(''); setStatusFilter('all'); setPage(1); }}>{t.dashboard.clearSearch}</button></>}
    </p>

    {visible.length > 0 && <section className="deployment-list" aria-label={t.dashboard.listLabel}>
      {visible.map((deployment) => <DeploymentRow key={deployment.id} deployment={deployment} now={now} onNavigate={onNavigate}
        menu={<RowMenu label={`${displayProjectName(deployment.projectName)} ${t.dashboard.deploymentNo(deployment.id)}`} items={menuItems(deployment)} onNavigate={onNavigate} />} />)}
    </section>}

    {pageCount > 1 && <nav className="pager" aria-label={t.dashboard.pagerLabel}>
      <Keycap variant="secondary" disabled={currentPage <= 1} onClick={() => goToPage(currentPage - 1)}>{t.dashboard.prevPage}</Keycap>
      <span className="pager__status" aria-current="page">{t.dashboard.pageOf(currentPage, pageCount)}</span>
      <Keycap variant="secondary" disabled={currentPage >= pageCount} onClick={() => goToPage(currentPage + 1)}>{t.dashboard.nextPage}</Keycap>
    </nav>}
  </>;
}
