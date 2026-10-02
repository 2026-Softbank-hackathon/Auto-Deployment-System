import { useEffect, useId, useRef, useState } from 'react';
import { cancelDeployment, listEnvironments, listSharedEnvironments, redeployDeployment, SERVERLESS_PROFILE, type DeployMode, type EnvironmentSummary } from '../../api/deployment-api';

/** 배포 형태로 서로 바뀌는 AWS 프로필 (컨테이너 · 서버리스) */
const AWS_COMPUTE_PROFILES = new Set(['aws-ecs-basic', SERVERLESS_PROFILE]);
import type { Navigate } from '../../app/navigation';
import { Keycap } from '../../components/ui/Keycap';
import { redeployReasonText, serverReasonText, useI18n } from '../../i18n/I18nProvider';
import { deploymentStatusView } from '../deployment-status/status-view';
import { DeploymentRow } from './DeploymentRow';
import { CONNECTIONS_PATH, EnvironmentChooser } from './EnvironmentChooser';
import { RowMenu, type RowMenuItem } from './RowMenu';
import { displayProjectName, isStalled, safeHttpUrl } from './format';
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
 * 프로젝트에서 쓸 수 있는 연결 = 프로젝트 전용 연결 + 공용 연결(#215). 같은 연결이 두 목록에 다 있으면 한 번만 넣는다.
 * 공용 연결 목록을 못 읽으면(그 기능이 없는 서버) 프로젝트 연결만 쓴다.
 */
async function loadDeployTargets(projectId: string): Promise<EnvironmentSummary[]> {
  const [own, shared] = await Promise.all([listEnvironments(projectId), listSharedEnvironments().catch(() => [])]);
  const ownIds = new Set(own.map((environment) => environment.id));
  return [...own, ...shared.filter((environment) => !ownIds.has(environment.id))];
}

/**
 * 배포 목록 + 검색 · 상태 필터 · 페이지 나누기. 배포 현황(전체)과 프로젝트 상세(한 프로젝트)가 같이 쓴다.
 * 받은 목록 안에서 찾는다 (전역 검색 API가 없다). 목록이 다시 들어와도 검색어 · 페이지는 유지한다.
 *
 * 행마다 "⋯" 메뉴가 있고, 끝난 배포(성공 · 실패 · 중단)는 거기서 재배포한다.
 * 성공한 이전 버전은 롤백(같은 환경에 그 배포를 다시 배포)할 수 있고, projectId를 주면 다른 종류의 환경(AWS ↔ 온프레미스)으로도 배포할 수 있다.
 */
export function DeploymentBrowser({ items, now, onNavigate, searchPlaceholder, onChanged, projectId }: {
  items: DeploymentListItem[]; now: number; onNavigate: Navigate;
  searchPlaceholder: string;
  /** 배포 상태를 바꾼 뒤(취소) 목록을 다시 읽게 한다 */
  onChanged?: () => void;
  /** 한 프로젝트의 목록일 때. 이 프로젝트의 연결을 읽어 "다른 환경으로 배포"를 보여 준다 */
  projectId?: string;
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
  const [failure, setFailure] = useState<{ id: string; title: string; reason: string } | null>(null);
  // 취소는 되돌릴 수 없어서 한 번 더 확인받는다.
  const [cancelTarget, setCancelTarget] = useState<DeploymentListItem | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // 롤백도 지금 서비스 중인 버전을 바꾸므로 한 번 더 확인받는다.
  const [rollbackTarget, setRollbackTarget] = useState<DeploymentListItem | null>(null);
  // 다른 환경으로 배포할 원래 배포 (연결 고르는 창이 열려 있는 동안)
  const [switchSource, setSwitchSource] = useState<DeploymentListItem | null>(null);

  // 다른 환경으로 배포할 수 있는 연결. null = 읽는 중
  const [targets, setTargets] = useState<EnvironmentSummary[] | 'error' | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    setTargets(null);
    loadDeployTargets(projectId).then((loaded) => { if (active) setTargets(loaded); }, () => { if (active) setTargets('error'); });
    return () => { active = false; };
  }, [projectId]);
  /** 원래 배포와 종류가 다른 연결. 종류를 모르는 옛 배포는 원래 연결이 아닌 것 모두 */
  const switchTargets = (item: DeploymentListItem) => (Array.isArray(targets) ? targets : [])
    .filter((environment) => (item.environmentType ? environment.type !== item.environmentType : environment.id !== item.environmentId));
  const environmentLabel = (item: DeploymentListItem) => (item.environmentType ? t.deploy.targets[item.environmentType] : t.versions.sameEnvironment);
  const itemName = (item: DeploymentListItem) => `${displayProjectName(item.projectName)} ${t.dashboard.deploymentNo(item.id)}`;

  /** 확인 줄은 한 번에 하나만 띄운다 */
  function ask(next: { cancel?: DeploymentListItem; rollback?: DeploymentListItem }) {
    setFailure(null);
    setCancelTarget(next.cancel ?? null);
    setRollbackTarget(next.rollback ?? null);
  }
  async function cancel(item: DeploymentListItem) {
    if (cancelling) return;
    setCancelling(true);
    setFailure(null);
    try {
      await cancelDeployment(item.id);
      setCancelTarget(null);
      onChanged?.();
    } catch (error) {
      setFailure({ id: item.id, title: t.cancel.failed, reason: serverReasonText(error, t, t.cancel.failed) });
      setCancelTarget(null);
    } finally {
      setCancelling(false);
    }
  }
  /** 재배포 · 롤백(같은 환경) · 다른 환경으로 배포. 새 배포가 만들어지면 그 진행 화면으로 간다. */
  async function redeploy(item: DeploymentListItem, failedTitle: string, targetEnvironmentId?: string, mode?: DeployMode) {
    if (starting) return;
    setStarting(item.id);
    setFailure(null);
    try {
      const created = await redeployDeployment(item.id, targetEnvironmentId, mode);
      onNavigate(`/deployments/${encodeURIComponent(created.deploymentId)}`);
    } catch (error) {
      setFailure({ id: item.id, title: failedTitle, reason: redeployReasonText(error, t, failedTitle) });
      setStarting(null);
      setRollbackTarget(null);
      setSwitchSource(null);
    }
  }

  /** 다른 환경으로 배포 메뉴 항목. 고를 연결이 없으면 이유와 함께 막고, 연결 화면으로 가는 길을 바로 아래에 둔다. */
  function switchItems(item: DeploymentListItem): RowMenuItem[] {
    const other = item.environmentType === 'aws' ? t.deploy.targets.onprem : item.environmentType === 'onprem' ? t.deploy.targets.aws : t.versions.otherConnection;
    const none = Array.isArray(targets) && switchTargets(item).length === 0;
    const disabledReason = blocked(item) ? t.redeploy.blocked
      : targets === null ? t.versions.switchLoading
        : targets === 'error' ? t.versions.switchLoadError
          : none ? t.versions.switchNeedsConnection(other) : undefined;
    return [
      { key: 'switch', label: t.versions.switchEnv, onSelect: () => { ask({}); setSwitchSource(item); }, disabledReason },
      ...(none ? [{ key: 'connections', label: t.versions.goConnections, href: CONNECTIONS_PATH }] : []),
    ];
  }

  /**
   * AWS 배포의 형태 바꾸기 (#282) — 컨테이너 ↔ 서버리스로 같은 소스를 다시 배포하고 앱의 형태도 바꾼다.
   * 고급 동작이라 기본 버튼이 아닌 메뉴에만 둔다.
   */
  function modeItems(item: DeploymentListItem): RowMenuItem[] {
    if (item.environmentType !== 'aws' || !item.targetProfile || !AWS_COMPUTE_PROFILES.has(item.targetProfile)) return [];
    const serverless = item.targetProfile === SERVERLESS_PROFILE;
    const label = serverless ? t.redeploy.toContainer : t.redeploy.toServerless;
    return [{
      key: 'mode', label,
      onSelect: () => void redeploy(item, t.redeploy.failed, undefined, serverless ? 'container' : 'serverless'),
      disabledReason: blocked(item) ? t.redeploy.blocked : undefined,
    }];
  }

  // 메뉴에는 행의 기본 버튼과 겹치지 않는 동작만 둔다. 기본 버튼이 이미 진행 화면(지켜보기 · 원인 보기 · 자세히)이나
  // 결과 화면으로 가므로, 같은 곳으로 가는 항목은 넣지 않는다.
  function menuItems(item: DeploymentListItem): RowMenuItem[] {
    // 진행 중인 배포는 취소만 할 수 있다. 취소하면 환경 락이 풀려 같은 프로젝트를 다시 배포할 수 있다.
    if (!finished(item)) return [{ key: 'cancel', label: t.cancel.button, onSelect: () => ask({ cancel: item }) }];
    const outcome = deploymentStatusView(item.status).outcome;
    // 기본 버튼이 "열기"인 건 지금 서비스 중인 배포뿐이다 (DeploymentRow)
    const opensLiveUrl = outcome === 'success' && item.isLive && safeHttpUrl(item.publicUrl) !== null;
    const blockedReason = blocked(item) ? t.redeploy.blocked : undefined;
    return [
      { key: 'redeploy', label: starting === item.id ? t.redeploy.starting : t.redeploy.button, onSelect: () => void redeploy(item, t.redeploy.failed), disabledReason: blockedReason },
      // 분석까지 끝난 배포만 다시 배포할 수 있다. 실패한 배포도 분석 뒤에 실패했으면 된다 (분석 결과가 없으면 서버가 거절).
      ...(projectId && (outcome === 'success' || outcome === 'failed') ? switchItems(item) : []),
      ...(outcome === 'success' || outcome === 'failed' ? modeItems(item) : []),
      // 지금 서비스 중이 아닌 성공 배포만 롤백할 수 있다.
      ...(outcome === 'success' && !item.isLive ? [{ key: 'rollback', label: t.versions.rollback, onSelect: () => ask({ rollback: item }), disabledReason: blockedReason }] : []),
      // 성공한 배포의 기본 버튼이 "열기"(배포된 앱)일 때만, 결과 화면으로 가는 길을 메뉴에 둔다.
      ...(opensLiveUrl ? [{ key: 'result', label: t.dashboard.viewResult, href: `/deployments/${encodeURIComponent(item.id)}/result` }] : []),
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

    {cancelTarget && <div className="selection-bar" role="alertdialog" aria-label={t.cancel.button}>
      <span>{t.cancel.confirm(itemName(cancelTarget))}</span>
      <Keycap disabled={cancelling} onClick={() => void cancel(cancelTarget)}>{cancelling ? t.cancel.cancelling : t.cancel.button}</Keycap>
      <Keycap variant="ghost" disabled={cancelling} onClick={() => setCancelTarget(null)}>{t.cancel.keep}</Keycap>
    </div>}
    {rollbackTarget && <div className="selection-bar" role="alertdialog" aria-label={t.versions.rollback}>
      <span>{t.versions.rollbackConfirm(itemName(rollbackTarget), environmentLabel(rollbackTarget))}</span>
      <Keycap sound="start" disabled={starting !== null} onClick={() => void redeploy(rollbackTarget, t.versions.rollbackFailed)}>{starting === rollbackTarget.id ? t.versions.rollbackStarting : t.versions.rollbackStart}</Keycap>
      <Keycap variant="ghost" disabled={starting !== null} onClick={() => setRollbackTarget(null)}>{t.versions.rollbackKeep}</Keycap>
    </div>}
    {projectId && <EnvironmentChooser open={switchSource !== null} sourceName={switchSource ? itemName(switchSource) : ''}
      environments={switchSource ? switchTargets(switchSource) : []} starting={starting !== null}
      onChoose={(environment) => { if (switchSource) void redeploy(switchSource, t.versions.switchFailed, environment.id); }}
      onClose={() => setSwitchSource(null)} onNavigate={onNavigate} />}
    {failure && <div className="notice error" role="alert"><strong>{t.dashboard.deploymentNo(failure.id)} — {failure.title}</strong><br />{failure.reason}</div>}

    <p className="dashboard-status" role="status" aria-live="polite">
      {filtered.length === 0 ? t.dashboard.noMatches : t.dashboard.showing(filtered.length, first + 1, first + visible.length)}
      {filtering && <> <button type="button" className="dashboard-tools__clear" onClick={() => { setQuery(''); setStatusFilter('all'); setPage(1); }}>{t.dashboard.clearSearch}</button></>}
    </p>

    {visible.length > 0 && <section className="deployment-list" aria-label={t.dashboard.listLabel}>
      {visible.map((deployment) => <DeploymentRow key={deployment.id} deployment={deployment} now={now} onNavigate={onNavigate}
        menu={<RowMenu label={itemName(deployment)} items={menuItems(deployment)} onNavigate={onNavigate} />} />)}
    </section>}

    {pageCount > 1 && <nav className="pager" aria-label={t.dashboard.pagerLabel}>
      <Keycap variant="secondary" disabled={currentPage <= 1} onClick={() => goToPage(currentPage - 1)}>{t.dashboard.prevPage}</Keycap>
      <span className="pager__status" aria-current="page">{t.dashboard.pageOf(currentPage, pageCount)}</span>
      <Keycap variant="secondary" disabled={currentPage >= pageCount} onClick={() => goToPage(currentPage + 1)}>{t.dashboard.nextPage}</Keycap>
    </nav>}
  </>;
}
