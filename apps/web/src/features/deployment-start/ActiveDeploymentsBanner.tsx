import { useId, useState, type MouseEvent } from 'react';
import { followAppLink, type Navigate } from '../../app/navigation';
import { Keycap } from '../../components/ui/Keycap';
import { Marble } from '../../components/ui/Marble';
import { useI18n } from '../../i18n/I18nProvider';
import { displayProjectName, elapsed, isStalled } from '../dashboard/format';
import { useDeploymentList, type DeploymentListItem } from '../dashboard/useDeploymentList';
import { deploymentStatusView } from '../deployment-status/status-view';

function progressPath(item: DeploymentListItem): string { return `/deployments/${encodeURIComponent(item.id)}`; }

/**
 * 간단 배포 화면 상단 띠. 진행 중인 배포가 있으면 진행 화면(연쇄장치 장면)으로 바로 들어갈 수 있게 한다.
 * 목록·상태는 대시보드와 같은 API(useDeploymentList)를 쓰고, 없거나 불러오지 못하면 아무것도 그리지 않는다.
 */
export function ActiveDeploymentsBanner({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useI18n();
  const { state } = useDeploymentList();
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (state.phase !== 'ready') return null;

  // 멈춘 배포(2시간 넘게 끝나지 않음)는 지켜볼 것이 없으므로 띠에 넣지 않는다. 대시보드에서는 계속 보인다.
  const active = state.items.filter((item) => deploymentStatusView(item.status).outcome === 'active' && !isStalled(true, item.createdAt, state.loadedAt));
  if (active.length === 0) return null;

  const describe = (item: DeploymentListItem) => {
    const view = deploymentStatusView(item.status);
    return `${t.status.stage[view.stageKey]} · ${elapsed(item.createdAt, state.loadedAt)}`;
  };
  const watch = (item: DeploymentListItem) => <Keycap variant="secondary" href={progressPath(item)} onClick={(event: MouseEvent<HTMLAnchorElement>) => followAppLink(event, onNavigate)}>
    {t.dashboard.watch}<span className="visually-hidden"> {displayProjectName(item.projectName)}</span>
  </Keycap>;
  const single = active.length === 1 ? active[0] : null;

  return <aside className="active-banner" aria-label={t.activeBanner.label}>
    <div className="active-banner__bar">
      <Marble tone="running" size={14} />
      <strong>{t.activeBanner.count(active.length)}</strong>
      {single && <span className="active-banner__detail">{displayProjectName(single.projectName)} · {describe(single)}</span>}
      <span className="active-banner__action">
        {single ? watch(single)
          : <Keycap variant="secondary" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>{open ? t.activeBanner.hideList : t.activeBanner.showList}</Keycap>}
      </span>
    </div>
    {!single && open && <ul id={listId} className="active-banner__list">
      {active.map((item) => <li key={item.id}>
        <span className="active-banner__name">{displayProjectName(item.projectName)}</span>
        <span className="active-banner__detail">{describe(item)}</span>
        {watch(item)}
      </li>)}
    </ul>}
  </aside>;
}
