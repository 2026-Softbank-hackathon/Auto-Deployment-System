import { useCallback, useEffect, useState } from 'react';
import { getProject, listProjectDeployments, SERVERLESS_PROFILE, STATIC_SITE_PROFILE, type EnvironmentSummary, type ProjectDeploymentSummary, type ProjectLiveDeployment } from '../api/deployment-api';
import { followAppLink, type Navigate } from '../app/navigation';
import type { ProjectTab } from '../app/routes';
import { DeployKeycap } from '../components/ui/DeployKeycap';
import { Keycap } from '../components/ui/Keycap';
import { DeploymentBrowser } from '../features/dashboard/DeploymentBrowser';
import { EnvironmentIcon } from '../features/dashboard/DeploymentRow';
import { displayProjectName, hostOf, safeHttpUrl } from '../features/dashboard/format';
import { AgentState } from '../features/connections/AgentState';
import { useDeployProject } from '../features/deployment-start/useDeployProject';
import { EnvVarsCard } from '../features/setup/EnvVarsCard';
import { DeleteAppCard } from '../features/project-delete/DeleteAppCard';
import { AddressCard } from '../features/app-address/AddressCard';
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
  const [state, setState] = useState<{ items: ProjectDeploymentSummary[]; loadedAt: number; more?: boolean } | { error: unknown } | null>(() => readCache<{ items: ProjectDeploymentSummary[]; loadedAt: number; more?: boolean }>(cacheKey) ?? null);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    let active = true;
    listProjectDeployments(projectId, { limit: DEPLOYMENTS_SHOWN }).then(
      (page) => { const next = { items: page.items, loadedAt: Date.now(), more: page.nextCursor !== null }; writeCache(cacheKey, next); if (active) setState(next); },
      (error) => { if (active) setState({ error }); },
    );
    return () => { active = false; };
  }, [projectId, reloadKey, cacheKey]);

  if (state === null) return <p className="dashboard-status" role="status">{t.dashboard.loading}</p>;
  if ('error' in state) return <div className="notice error" role="alert"><strong>{t.dashboard.loadError}</strong><br />{errorMessage(state.error, t, t.dashboard.loadError)}</div>;
  if (state.items.length === 0) return <p className="dashboard-status">{t.projects.neverDeployed}</p>;
  return <>
    <DeploymentBrowser items={state.items.map((deployment) => ({ ...deployment, projectName }))} now={state.loadedAt} onNavigate={onNavigate}
      searchPlaceholder={t.projects.searchPlaceholder} onChanged={() => setReloadKey((key) => key + 1)} projectId={projectId} />
    {/* 서버에 더 오래된 배포가 남아 있으면(nextCursor) 숨기지 않고 알린다 */}
    {state.more && <p className="dashboard-status">{t.projects.olderHidden(DEPLOYMENTS_SHOWN)}</p>}
  </>;
}

/**
 * 지금 이 앱이 어디서(AWS / 온프레미스) 서비스 중인지와 주소 (#220). 읽지 못하면 아무것도 보여 주지 않는다.
 * 주소를 바꾸면(#302) reloadKey 가 바뀌어 새 주소를 다시 읽는다.
 */
function LiveSummary({ projectId, reloadKey }: { projectId: string; reloadKey: number }) {
  const { t } = useI18n();
  const cacheKey = `project-live:${projectId}`;
  const [live, setLive] = useState<ProjectLiveDeployment | null | undefined>(() => readCache<ProjectLiveDeployment | null>(cacheKey));
  useEffect(() => {
    let active = true;
    getProject(projectId).then((project) => { writeCache(cacheKey, project.live); if (active) setLive(project.live); }, () => { /* 없어도 화면은 동작한다 */ });
    return () => { active = false; };
  }, [projectId, cacheKey, reloadKey]);

  if (live === undefined) return null;
  if (live === null) return <p className="project-live">{t.versions.notLive}</p>;
  const url = safeHttpUrl(live.publicUrl);
  return <p className="project-live">
    {live.environmentType && <EnvironmentIcon type={live.environmentType} />}
    <strong>{t.versions.liveOn(live.environmentType ? t.deploy.targets[live.environmentType] : t.versions.unknownEnvironment)}</strong>
    {live.targetProfile === SERVERLESS_PROFILE && <span className="serverless-badge">{t.deploy.serverlessBadge}</span>}
    {live.targetProfile === STATIC_SITE_PROFILE && <span className="static-site-badge" title={t.run.staticSite.aws}>{t.run.staticSite.badge}</span>}
    {url && <a href={url} target="_blank" rel="noreferrer">{hostOf(url)}<span className="visually-hidden"> {t.dashboard.newTab}</span></a>}
    <span className="project-live__no">{t.dashboard.deploymentNo(live.deploymentId)}</span>
  </p>;
}

/**
 * 이 앱에만 묶인 예전 방식의 연결 (공용 연결 이전에 앱마다 등록한 것). 여기서는 보기만 하고, 새 연결은 연결 화면에서 등록한다 (#218).
 * 간단 배포에서 이 앱을 고르면 공용 연결과 함께 고를 수 있다.
 */
function AppConnections({ environments, onNavigate }: { environments: EnvironmentSummary[]; onNavigate: Navigate }) {
  const { t } = useI18n();
  const copy = t.connections.legacy;
  const now = Date.now();
  return <section className="setup-card" aria-labelledby="app-connections-title">
    <div className="setup-card__head"><h2 id="app-connections-title">{copy.title}</h2></div>
    <div className="setup-card__body">
      <p>{environments.length > 0 ? copy.copy : copy.none}</p>
      {environments.length > 0 && <ul className="connection-list" aria-labelledby="app-connections-title">
        {environments.map((environment) => <li key={environment.id} className="connection-row">
          <div className="connection-row__main">
            <strong>{t.deploy.targets[environment.type]} · {environment.type === 'aws' ? environment.region ?? environment.name : environment.hostname ?? environment.name}</strong>
            <span>{environment.name}</span>
          </div>
          <div className="connection-row__state">
            {environment.type === 'onprem' && <AgentState connection={environment} now={now} />}
            {environment.isDefault && <span className="connection-badge">{t.connections.default}</span>}
          </div>
        </li>)}
      </ul>}
      <div><a className="setup-summary__link" href="/connections" onClick={(event) => followAppLink(event, onNavigate)}>{copy.manage}</a></div>
    </div>
  </section>;
}

/**
 * 프로젝트 상세 (#150): 한 프로젝트의 배포 내역 · 환경변수 · 설정(이 앱에만 묶인 연결 · 앱 삭제)을 탭으로 본다.
 * 설정 탭은 "지금 고른 프로젝트"의 연결을 보여 주므로, 이 화면에 들어오면 그 프로젝트를 고른 것으로 맞춘다.
 */
export function ProjectDetailPage({ projectId, tab, onNavigate }: { projectId: string; tab: ProjectTab; onNavigate: Navigate }) {
  const { t } = useI18n();
  const copy = t.projects;
  const { state, refresh, selectProject } = useDeployProject();
  const known = state.phase === 'ready' ? state.projects.find((project) => project.id === projectId) ?? null : null;
  const selectedHere = state.phase === 'ready' && state.project?.id === projectId;
  // 설정 탭에서 주소를 바꾸면 머리의 주소를 다시 읽는다 (#302)
  const [addressVersion, setAddressVersion] = useState(0);
  const addressChanged = useCallback(() => setAddressVersion((version) => version + 1), []);

  // 목록이 준비되면 이 프로젝트를 고른다. 목록에 없는 ID면 고르지 않는다.
  const shouldSelect = known !== null && !selectedHere;
  useEffect(() => { if (shouldSelect) void selectProject(projectId); }, [shouldSelect, projectId, selectProject]);

  const back = <a className="project-detail__back" href="/" onClick={(event) => followAppLink(event, onNavigate)}>← {t.nav.dashboard}</a>;

  if (state.phase === 'loading') return <>{back}<p className="dashboard-status" role="status">{copy.loading}</p></>;
  if (state.phase === 'error') return <>{back}<div className="notice error" role="alert"><strong>{copy.loadError}</strong><br />{errorMessage(state.error, t, copy.loadError)}
    <div className="page-actions"><Keycap variant="secondary" onClick={() => void refresh()}>{t.dashboard.retry}</Keycap></div></div></>;
  if (!known) return <>{back}<div className="notice error" role="alert">{copy.notFound}</div></>;

  const base = `/projects/${encodeURIComponent(projectId)}`;
  const appAws = state.environments.find((environment) => environment.type === 'aws' && environment.isDefault) ?? null;
  return <>
    {back}
    <div className="page-head">
      <div><h1>{displayProjectName(known.name)}</h1><p>{copy.detailDescription}</p><LiveSummary projectId={projectId} reloadKey={addressVersion} /></div>
      {/* 연결은 간단 배포에서 고른다. 이 앱을 골라 둔 채로 간다. */}
      <DeployKeycap href={`/deploy?project=${encodeURIComponent(projectId)}`} onClick={(event) => followAppLink(event, onNavigate)}>{copy.deploy}</DeployKeycap>
    </div>

    <nav className="tabs" aria-label={copy.tabsLabel}>
      {tabs.map((item) => <a key={item.tab} href={`${base}${item.path}`} className="tabs__tab" aria-current={item.tab === tab ? 'page' : undefined}
        onClick={(event) => followAppLink(event, onNavigate)}>{copy.tabs[item.tab]}</a>)}
    </nav>

    {tab === 'deployments' && <Deployments projectId={projectId} projectName={known.name} onNavigate={onNavigate} />}
    {/* 환경변수 · 설정은 고른 프로젝트의 연결 상태를 쓰므로, 전환이 끝난 뒤에 보여 준다. */}
    {tab !== 'deployments' && !selectedHere && <p className="dashboard-status" role="status">{t.setup.loading}</p>}
    {tab === 'env' && selectedHere && <section className="setup-card" aria-label={t.setup.env.title}>
      <div className="setup-card__body"><EnvVarsCard projectId={projectId} awsRegion={appAws?.region ?? null} /></div>
    </section>}
    {tab === 'settings' && selectedHere && <>
      <AddressCard projectId={projectId} onChanged={addressChanged} />
      <AppConnections environments={state.environments} onNavigate={onNavigate} />
      <DeleteAppCard projectId={projectId} appName={displayProjectName(known.name)} onDeleted={() => void refresh()} onNavigate={onNavigate} />
    </>}
  </>;
}
