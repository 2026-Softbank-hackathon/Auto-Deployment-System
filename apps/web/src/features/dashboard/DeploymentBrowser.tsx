import { useId, useRef, useState } from 'react';
import { redeployDeployment } from '../../api/deployment-api';
import type { Navigate } from '../../app/navigation';
import { Keycap } from '../../components/ui/Keycap';
import { serverReasonText, useI18n } from '../../i18n/I18nProvider';
import { deploymentStatusView } from '../deployment-status/status-view';
import { DeploymentRow } from './DeploymentRow';
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
 * 배포 목록 + 검색 · 상태 필터 · 페이지 나누기 + 골라서 재배포. 배포 현황(전체)과 프로젝트 상세(한 프로젝트)가 같이 쓴다.
 * 받은 목록 안에서 찾는다 (전역 검색 API가 없다). 목록이 다시 들어와도 검색어 · 페이지 · 선택은 유지한다.
 *
 * 재배포는 끝난 배포(성공 · 실패 · 중단)를 골라 한 번에 시작한다. 서버가 한 환경에서 배포를 하나씩만 돌리므로
 * 같은 프로젝트에서는 하나만 고를 수 있다. selection이 'single'이면 전체에서 하나만 고른다.
 */
export function DeploymentBrowser({ items, now, onNavigate, searchPlaceholder, selection, onRedeployed }: {
  items: DeploymentListItem[]; now: number; onNavigate: Navigate;
  searchPlaceholder: string;
  /** multi: 프로젝트당 하나씩 여러 건, single: 한 건만 */
  selection: 'multi' | 'single';
  /** 재배포를 시작한 뒤 목록을 다시 읽게 한다 */
  onRedeployed?: () => void;
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

  // 골라 둔 배포. 다른 페이지나 검색 결과 밖에 있어도 유지한다. 목록에서 사라졌거나 진행 중이 된 것은 뺀다.
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ started: number; failures: Array<{ id: string; reason: string }> } | null>(null);
  const finished = (item: DeploymentListItem) => deploymentStatusView(item.status).outcome !== 'active';
  // 같은 프로젝트에 진행 중인 배포가 있으면 재배포를 고를 수 없게 한다. 서버도 환경을 잡고 있는 배포가 있으면
  // 재배포를 거절한다 (apps/api deployment-service redeploy: DEPLOYMENT_LOCKED). 눌러 보고 실패하지 않도록 미리 막는다.
  // 2시간 넘게 멈춘 배포는 진행 중으로 치지 않지만, 환경을 잡고 있는 상태면 서버가 거절하므로 그대로 막는다.
  const blocked = (item: DeploymentListItem) => items.some((other) => other.id !== item.id && other.projectName === item.projectName
    && !finished(other) && (LOCKING_STATUSES.has(other.status) || !isStalled(true, other.createdAt, now)));
  const selectable = (item: DeploymentListItem) => finished(item) && !blocked(item);
  const chosen = items.filter((item) => picked.has(item.id) && selectable(item));

  function toggle(item: DeploymentListItem) {
    setConfirming(false);
    setResult(null);
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(item.id)) { next.delete(item.id); return next; }
      // 같은 프로젝트(= 같은 환경)에서는 하나만. single이면 전체에서 하나만.
      for (const other of items) if (next.has(other.id) && (selection === 'single' || other.projectName === item.projectName)) next.delete(other.id);
      next.add(item.id);
      return next;
    });
  }

  async function redeploySelected() {
    if (busy || chosen.length === 0) return;
    setBusy(true);
    const targets = chosen;
    const outcomes = await Promise.allSettled(targets.map((item) => redeployDeployment(item.id)));
    const failures = outcomes.flatMap((outcome, index) => outcome.status === 'rejected'
      ? [{ id: targets[index].id, reason: serverReasonText(outcome.reason, t, t.redeploy.failed) }] : []);
    const started = outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value.deploymentId] : []));
    setBusy(false);
    setConfirming(false);
    // 한 건만 골라 성공했으면 그 배포의 진행 화면으로 간다. 여러 건이면 목록에 남아 결과를 보여 준다.
    if (targets.length === 1 && started.length === 1) { onNavigate(`/deployments/${encodeURIComponent(started[0])}`); return; }
    setPicked(new Set(failures.map((failure) => failure.id)));
    setResult({ started: started.length, failures });
    if (started.length > 0) onRedeployed?.();
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

    {chosen.length > 0 && <div className="selection-bar" role="region" aria-label={t.redeploy.barLabel}>
      {confirming
        ? <>
          <span>{t.redeploy.confirm(chosen.length)}</span>
          <Keycap sound="start" disabled={busy} onClick={() => void redeploySelected()}>{busy ? t.redeploy.starting : t.redeploy.button}</Keycap>
          <Keycap variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{t.deploy.aws.cancel}</Keycap>
        </>
        : <>
          <span>{t.redeploy.selected(chosen.length)}</span>
          <Keycap onClick={() => setConfirming(true)}>{t.redeploy.button}</Keycap>
          <Keycap variant="ghost" onClick={() => setPicked(new Set())}>{t.redeploy.clear}</Keycap>
        </>}
    </div>}
    {result && <div className={`notice ${result.failures.length > 0 ? 'error' : ''}`} role="status">
      {result.started > 0 && <strong>{t.redeploy.started(result.started)}</strong>}
      {result.failures.length > 0 && <ul className="analysis-lines">{result.failures.map((failure) => <li key={failure.id}><strong>{t.dashboard.deploymentNo(failure.id)}</strong> — {failure.reason}</li>)}</ul>}
    </div>}

    <p className="dashboard-status" role="status" aria-live="polite">
      {selection === 'multi' && visible.some(selectable) && chosen.length === 0 && <>{t.redeploy.hintMulti} </>}
      {selection === 'single' && visible.some(selectable) && chosen.length === 0 && <>{t.redeploy.hintSingle} </>}
      {visible.some((item) => finished(item) && blocked(item)) && <>{t.redeploy.blockedHint} </>}
      {filtered.length === 0 ? t.dashboard.noMatches : t.dashboard.showing(filtered.length, first + 1, first + visible.length)}
      {filtering && <> <button type="button" className="dashboard-tools__clear" onClick={() => { setQuery(''); setStatusFilter('all'); setPage(1); }}>{t.dashboard.clearSearch}</button></>}
    </p>

    {visible.length > 0 && <section className="deployment-list" aria-label={t.dashboard.listLabel}>
      {visible.map((deployment) => <div key={deployment.id} className="deployment-pick">
        {/* 진행 중인 배포는 재배포할 수 없어 고르는 칸을 비워 둔다(줄 맞춤용 자리만 남긴다). */}
        {!finished(deployment)
          ? <span className="deployment-pick__box" aria-hidden="true" />
          : blocked(deployment)
            ? <input type="checkbox" className="deployment-pick__box" checked={false} disabled readOnly title={t.redeploy.blocked}
              aria-label={`${t.redeploy.pick(`${displayProjectName(deployment.projectName)} ${t.dashboard.deploymentNo(deployment.id)}`)} — ${t.redeploy.blocked}`} />
            : <input type="checkbox" className="deployment-pick__box" checked={picked.has(deployment.id)} disabled={busy} onChange={() => toggle(deployment)}
              aria-label={t.redeploy.pick(`${displayProjectName(deployment.projectName)} ${t.dashboard.deploymentNo(deployment.id)}`)} />}
        <DeploymentRow deployment={deployment} now={now} onNavigate={onNavigate} />
      </div>)}
    </section>}

    {pageCount > 1 && <nav className="pager" aria-label={t.dashboard.pagerLabel}>
      <Keycap variant="secondary" disabled={currentPage <= 1} onClick={() => goToPage(currentPage - 1)}>{t.dashboard.prevPage}</Keycap>
      <span className="pager__status" aria-current="page">{t.dashboard.pageOf(currentPage, pageCount)}</span>
      <Keycap variant="secondary" disabled={currentPage >= pageCount} onClick={() => goToPage(currentPage + 1)}>{t.dashboard.nextPage}</Keycap>
    </nav>}
  </>;
}
