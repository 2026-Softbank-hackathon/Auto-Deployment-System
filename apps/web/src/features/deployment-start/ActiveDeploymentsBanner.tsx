import { useId, useState, type MouseEvent } from 'react';
import { followAppLink, type Navigate } from '../../app/navigation';
import { Keycap } from '../../components/ui/Keycap';
import { Marble } from '../../components/ui/Marble';
import { useI18n } from '../../i18n/I18nProvider';
import { displayProjectName, elapsed } from '../dashboard/format';
import { latestActive, useProjectList } from '../dashboard/useProjectList';
import { deploymentStatusView } from '../deployment-status/status-view';

/** 진행 중인 배포 한 건 (앱마다 최근 배포만 본다) */
interface ActiveItem { id: string; status: string; createdAt: string; projectName: string }

function progressPath(item: ActiveItem): string { return `/deployments/${encodeURIComponent(item.id)}`; }

/**
 * 간단 배포 화면 상단 띠. 진행 중인 배포가 있으면 진행 화면(연쇄장치 장면)으로 바로 들어갈 수 있게 한다.
 * 목록·상태는 대시보드와 같은 앱 목록(useProjectList)을 쓰고, 없거나 불러오지 못하면 아무것도 그리지 않는다.
 */
export function ActiveDeploymentsBanner({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useI18n();
  const { state } = useProjectList();
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (state.phase !== 'ready') return null;

  // 멈춘 배포(2시간 넘게 끝나지 않음)는 지켜볼 것이 없으므로 띠에 넣지 않는다. 대시보드에서는 계속 보인다.
  const active: ActiveItem[] = state.projects.flatMap((project) => project.latest && latestActive(project, state.loadedAt)
    ? [{ id: project.latest.deploymentId, status: project.latest.status, createdAt: project.latest.createdAt, projectName: project.name }] : []);
  if (active.length === 0) return null;

  const describe = (item: ActiveItem) => {
    const view = deploymentStatusView(item.status);
    return `${t.status.stage[view.stageKey]} · ${elapsed(item.createdAt, state.loadedAt)}`;
  };
  const watch = (item: ActiveItem) => <Keycap variant="secondary" href={progressPath(item)} onClick={(event: MouseEvent<HTMLAnchorElement>) => followAppLink(event, onNavigate)}>
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
