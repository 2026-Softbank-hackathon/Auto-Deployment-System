import { useEffect, useState } from 'react';
import { listProjectDeployments, type ProjectDeploymentSummary } from '../api/deployment-api';
import { followAppLink, type Navigate } from '../app/navigation';
import type { ProjectTab } from '../app/routes';
import { DeployKeycap } from '../components/ui/DeployKeycap';
import { Keycap } from '../components/ui/Keycap';
import { DeploymentBrowser } from '../features/dashboard/DeploymentBrowser';
import { displayProjectName } from '../features/dashboard/format';
import { setupStatus, useDeployProject } from '../features/deployment-start/useDeployProject';
import { RedeployButton } from '../features/deployment-progress/RedeployButton';
import { deploymentStatusView } from '../features/deployment-status/status-view';
import { ConnectionCards } from '../features/setup/ConnectionCards';
import { EnvVarsCard } from '../features/setup/EnvVarsCard';
import { errorMessage, useI18n } from '../i18n/I18nProvider';

/** 서버가 한 번에 주는 최대 건수. 이 안에서 검색 · 페이지 나누기를 한다. */
const DEPLOYMENTS_SHOWN = 100;
const tabs: ReadonlyArray<{ tab: ProjectTab; path: string }> = [
  { tab: 'deployments', path: '' },
  { tab: 'env', path: '/env' },
  { tab: 'settings', path: '/settings' },
];

function Deployments({ projectId, projectName, onNavigate }: { projectId: string; projectName: string; onNavigate: Navigate }) {
  const { t } = useI18n();
  const [state, setState] = useState<{ items: ProjectDeploymentSummary[]; loadedAt: number } | { error: unknown } | null>(null);
  useEffect(() => {
    let active = true;
    setState(null);
    listProjectDeployments(projectId, { limit: DEPLOYMENTS_SHOWN }).then(
      (page) => { if (active) setState({ items: page.items, loadedAt: Date.now() }); },
      (error) => { if (active) setState({ error }); },
    );
    return () => { active = false; };
  }, [projectId]);

  if (state === null) return <p className="dashboard-status" role="status">{t.dashboard.loading}</p>;
  if ('error' in state) return <div className="notice error" role="alert"><strong>{t.dashboard.loadError}</strong><br />{errorMessage(state.error, t, t.dashboard.loadError)}</div>;
  if (state.items.length === 0) return <p className="dashboard-status">{t.projects.neverDeployed}</p>;
  return <DeploymentBrowser items={state.items.map((deployment) => ({ ...deployment, projectName }))} now={state.loadedAt} onNavigate={onNavigate}
    searchPlaceholder={t.projects.searchPlaceholder}
    extraAction={(deployment) => deploymentStatusView(deployment.status).outcome === 'active' ? undefined
      : <RedeployButton compact variant="ghost" deploymentId={deployment.id} onStarted={(id) => onNavigate(`/deployments/${encodeURIComponent(id)}`)} />} />;
}

/**
 * 프로젝트 상세 (#150): 한 프로젝트의 배포 내역 · 환경변수 · 설정(AWS · 온프레미스 연결)을 탭으로 본다.
 * 연결 카드는 "지금 고른 프로젝트"를 다루므로, 이 화면에 들어오면 그 프로젝트를 고른 것으로 맞춘다.
 */
export function ProjectDetailPage({ projectId, tab, onNavigate }: { projectId: string; tab: ProjectTab; onNavigate: Navigate }) {
  const { t } = useI18n();
  const copy = t.projects;
  const { state, refresh, selectProject } = useDeployProject();
  const status = setupStatus(state);
  const known = state.phase === 'ready' ? state.projects.find((project) => project.id === projectId) ?? null : null;
  const selectedHere = state.phase === 'ready' && state.project?.id === projectId;

  // 목록이 준비되면 이 프로젝트를 고른다. 목록에 없는 ID면 고르지 않는다.
  const shouldSelect = known !== null && !selectedHere;
  useEffect(() => { if (shouldSelect) void selectProject(projectId); }, [shouldSelect, projectId, selectProject]);

  const back = <a className="project-detail__back" href="/projects" onClick={(event) => followAppLink(event, onNavigate)}>← {t.nav.projects}</a>;

  if (state.phase === 'loading') return <>{back}<p className="dashboard-status" role="status">{copy.loading}</p></>;
  if (state.phase === 'error') return <>{back}<div className="notice error" role="alert"><strong>{copy.loadError}</strong><br />{errorMessage(state.error, t, copy.loadError)}
    <div className="page-actions"><Keycap variant="secondary" onClick={() => void refresh()}>{t.dashboard.retry}</Keycap></div></div></>;
  if (!known) return <>{back}<div className="notice error" role="alert">{copy.notFound}</div></>;

  const base = `/projects/${encodeURIComponent(projectId)}`;
  const deployReady = selectedHere && status.ready && status.awsReady;
  return <>
    {back}
    <div className="page-head">
      <div><h1>{displayProjectName(known.name)}</h1><p>{copy.detailDescription}</p></div>
      {/* AWS 연결은 어느 대상이든 필수라, 등록 전에는 배포로 보내지 않는다. */}
      {deployReady
        ? <DeployKeycap href="/deploy" onClick={(event) => followAppLink(event, onNavigate)}>{copy.deploy}</DeployKeycap>
        : <DeployKeycap disabled>{copy.deploy}</DeployKeycap>}
    </div>
    {selectedHere && !deployReady && <div className="notice" role="status">
      {status.ready && status.keysMissing ? copy.needsKeyAgain : copy.needsAws}{' '}
      {tab !== 'settings' && <a className="setup-summary__link" href={`${base}/settings`} onClick={(event) => followAppLink(event, onNavigate)}>{copy.goSettings}</a>}
    </div>}

    <nav className="tabs" aria-label={copy.tabsLabel}>
      {tabs.map((item) => <a key={item.tab} href={`${base}${item.path}`} className="tabs__tab" aria-current={item.tab === tab ? 'page' : undefined}
        onClick={(event) => followAppLink(event, onNavigate)}>{copy.tabs[item.tab]}</a>)}
    </nav>

    {tab === 'deployments' && <Deployments projectId={projectId} projectName={known.name} onNavigate={onNavigate} />}
    {/* 환경변수 · 설정은 고른 프로젝트의 연결 상태를 쓰므로, 전환이 끝난 뒤에 보여 준다. */}
    {tab !== 'deployments' && !selectedHere && <p className="dashboard-status" role="status">{t.setup.loading}</p>}
    {tab === 'env' && selectedHere && <section className="setup-card" aria-label={t.setup.env.title}>
      <div className="setup-card__body"><EnvVarsCard projectId={projectId} awsRegion={status.ready ? status.aws?.region ?? null : null} /></div>
    </section>}
    {tab === 'settings' && selectedHere && <ConnectionCards />}
  </>;
}
