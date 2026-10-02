import { useEffect, useState } from 'react';
import { getProject, listProjectDeployments, type ProjectDeploymentSummary, type ProjectLiveDeployment } from '../api/deployment-api';
import { followAppLink, type Navigate } from '../app/navigation';
import type { ProjectTab } from '../app/routes';
import { DeployKeycap } from '../components/ui/DeployKeycap';
import { Keycap } from '../components/ui/Keycap';
import { DeploymentBrowser } from '../features/dashboard/DeploymentBrowser';
import { EnvironmentIcon } from '../features/dashboard/DeploymentRow';
import { displayProjectName, hostOf, safeHttpUrl } from '../features/dashboard/format';
import { setupStatus, useDeployProject } from '../features/deployment-start/useDeployProject';
import { ConnectionCards } from '../features/setup/ConnectionCards';
import { EnvVarsCard } from '../features/setup/EnvVarsCard';
import { readCache, writeCache } from '../lib/page-cache';
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
  const cacheKey = `project-deployments:${projectId}`;
  // 직전에 받은 배포 내역이 있으면 먼저 보여 주고, 바로 다시 읽는다.
  const [state, setState] = useState<{ items: ProjectDeploymentSummary[]; loadedAt: number } | { error: unknown } | null>(() => readCache<{ items: ProjectDeploymentSummary[]; loadedAt: number }>(cacheKey) ?? null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let active = true;
    listProjectDeployments(projectId, { limit: DEPLOYMENTS_SHOWN }).then(
      (page) => { const next = { items: page.items, loadedAt: Date.now() }; writeCache(cacheKey, next); if (active) setState(next); },
      (error) => { if (active) setState({ error }); },
    );
    return () => { active = false; };
  }, [projectId, reloadKey, cacheKey]);

  if (state === null) return <p className="dashboard-status" role="status">{t.dashboard.loading}</p>;
  if ('error' in state) return <div className="notice error" role="alert"><strong>{t.dashboard.loadError}</strong><br />{errorMessage(state.error, t, t.dashboard.loadError)}</div>;
  if (state.items.length === 0) return <p className="dashboard-status">{t.projects.neverDeployed}</p>;
  return <DeploymentBrowser items={state.items.map((deployment) => ({ ...deployment, projectName }))} now={state.loadedAt} onNavigate={onNavigate}
    searchPlaceholder={t.projects.searchPlaceholder} onChanged={() => setReloadKey((key) => key + 1)} projectId={projectId} />;
}

/** 지금 이 앱이 어디서(AWS / 온프레미스) 서비스 중인지와 주소 (#220). 읽지 못하면 아무것도 보여 주지 않는다. */
function LiveSummary({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const cacheKey = `project-live:${projectId}`;
  const [live, setLive] = useState<ProjectLiveDeployment | null | undefined>(() => readCache<ProjectLiveDeployment | null>(cacheKey));
  useEffect(() => {
    let active = true;
    getProject(projectId).then((project) => { writeCache(cacheKey, project.live); if (active) setLive(project.live); }, () => { /* 없어도 화면은 동작한다 */ });
    return () => { active = false; };
  }, [projectId, cacheKey]);

  if (live === undefined) return null;
  if (live === null) return <p className="project-live">{t.versions.notLive}</p>;
  const url = safeHttpUrl(live.publicUrl);
  return <p className="project-live">
    {live.environmentType && <EnvironmentIcon type={live.environmentType} />}
    <strong>{t.versions.liveOn(live.environmentType ? t.deploy.targets[live.environmentType] : t.versions.unknownEnvironment)}</strong>
    {url && <a href={url} target="_blank" rel="noreferrer">{hostOf(url)}<span className="visually-hidden"> {t.dashboard.newTab}</span></a>}
    <span className="project-live__no">{t.dashboard.deploymentNo(live.deploymentId)}</span>
  </p>;
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

  const back = <a className="project-detail__back" href="/" onClick={(event) => followAppLink(event, onNavigate)}>← {t.nav.dashboard}</a>;

  if (state.phase === 'loading') return <>{back}<p className="dashboard-status" role="status">{copy.loading}</p></>;
  if (state.phase === 'error') return <>{back}<div className="notice error" role="alert"><strong>{copy.loadError}</strong><br />{errorMessage(state.error, t, copy.loadError)}
    <div className="page-actions"><Keycap variant="secondary" onClick={() => void refresh()}>{t.dashboard.retry}</Keycap></div></div></>;
  if (!known) return <>{back}<div className="notice error" role="alert">{copy.notFound}</div></>;

  const base = `/projects/${encodeURIComponent(projectId)}`;
  const deployReady = selectedHere && status.ready && status.awsReady;
  return <>
    {back}
    <div className="page-head">
      <div><h1>{displayProjectName(known.name)}</h1><p>{copy.detailDescription}</p><LiveSummary projectId={projectId} /></div>
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
