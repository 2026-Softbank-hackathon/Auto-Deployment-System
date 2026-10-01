import { useEffect, useId, useRef, useState } from 'react';
import { listEnvironments, listProjectDeployments, listProjectEnv, listSecretNames, type EnvironmentSummary, type ProjectDeploymentSummary } from '../api/deployment-api';
import { followAppLink, type Navigate } from '../app/navigation';
import { Keycap } from '../components/ui/Keycap';
import { StatusTape } from '../components/ui/StatusTape';
import { displayProjectName, relativeTime } from '../features/dashboard/format';
import { awsKeysMissing, useDeployProject, type DeployProject } from '../features/deployment-start/useDeployProject';
import { deploymentStatusView } from '../features/deployment-status/status-view';
import { ProjectNameForm } from '../features/projects/ProjectNameForm';
import { errorMessage, useI18n } from '../i18n/I18nProvider';

/** 프로젝트 한 개의 연결 상태. 부가 정보(환경변수 · 최근 배포)는 읽지 못해도 줄은 보여 준다(null). */
interface ProjectStatus {
  aws: EnvironmentSummary | null;
  keysMissing: boolean;
  onprem: EnvironmentSummary | null;
  envCount: number | null;
  latest: ProjectDeploymentSummary | null;
}

async function loadStatus(projectId: string): Promise<ProjectStatus> {
  const [environments, secretNames, envVars, deployments] = await Promise.all([
    listEnvironments(projectId),
    listSecretNames(projectId).catch(() => null),
    listProjectEnv(projectId).catch(() => null),
    listProjectDeployments(projectId, { limit: 1 }).catch(() => null),
  ]);
  const defaultOf = (type: EnvironmentSummary['type']) => environments.find((environment) => environment.type === type && environment.isDefault) ?? null;
  return { aws: defaultOf('aws'), keysMissing: awsKeysMissing(environments, secretNames), onprem: defaultOf('onprem'), envCount: envVars ? envVars.length : null, latest: deployments?.items[0] ?? null };
}

function ProjectCard({ project, selected, onOpen, onNavigate }: { project: DeployProject; selected: boolean; onOpen: (path: string) => void; onNavigate: Navigate }) {
  const { t } = useI18n();
  const copy = t.projects;
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    loadStatus(project.id).then((next) => { if (active) setStatus(next); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [project.id]);

  const awsReady = status !== null && status.aws !== null && !status.keysMissing;
  const latestView = status?.latest ? deploymentStatusView(status.latest.status) : null;
  return <li className={`project-card ${selected ? 'is-selected' : ''}`}>
    <div className="project-card__head">
      <h2><a href={`/projects/${encodeURIComponent(project.id)}`} onClick={(event) => followAppLink(event, onNavigate)}>{displayProjectName(project.name)}</a></h2>
      {selected && <StatusTape tone="running">{copy.selected}</StatusTape>}
    </div>
    {failed && <p className="project-card__error" role="alert">{copy.statusError}</p>}
    {!failed && status === null && <p role="status">{copy.statusLoading}</p>}
    {status !== null && <dl className="project-card__facts">
      <div><dt>{copy.aws}</dt><dd className={awsReady ? 'is-ok' : 'is-missing'}>{status.keysMissing ? copy.keysMissing : status.aws ? `✓ ${status.aws.region ?? status.aws.name}` : copy.notConnected}</dd></div>
      <div><dt>{copy.onprem}</dt><dd className={status.onprem ? 'is-ok' : ''}>{status.onprem ? `✓ ${status.onprem.hostname ?? status.onprem.name}` : copy.notRegistered}</dd></div>
      <div><dt>{copy.env}</dt><dd>{status.envCount === null ? copy.unknown : copy.envCount(status.envCount)}</dd></div>
      <div><dt>{copy.latest}</dt><dd>{status.latest && latestView
        ? <a href={`/deployments/${encodeURIComponent(status.latest.id)}`} onClick={(event) => followAppLink(event, onNavigate)}>{t.dashboard.deploymentNo(status.latest.id)} · {t.status.stage[latestView.stageKey]} · {relativeTime(status.latest.createdAt, Date.now(), t)}</a>
        : copy.neverDeployed}</dd></div>
    </dl>}
    <div className="project-card__actions">
      <Keycap variant="secondary" onClick={() => onOpen(`/projects/${encodeURIComponent(project.id)}`)}>{copy.openDetail}</Keycap>
      {/* AWS 연결은 어느 대상이든 필수라(이미지를 ECR에 둔다), 없으면 배포로 보내지 않는다. */}
      <Keycap disabled={!awsReady} onClick={() => onOpen('/deploy')}>{copy.deploy}</Keycap>
    </div>
  </li>;
}

const PAGE_SIZE = 9;

/**
 * 내 프로젝트: 프로젝트마다 배포할 준비가 됐는지(AWS · 온프레미스 · 환경변수)를 한눈에 본다.
 * 배포 한 건 한 건의 진행 · 결과는 대시보드에서 본다. 프로젝트를 지우는 API는 없다.
 */
export function ProjectsPage({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useI18n();
  const copy = t.projects;
  const { state, refresh, createDeployProject, selectProject } = useDeployProject();
  const [adding, setAdding] = useState(false);
  useEffect(() => { void refresh(); }, [refresh]);
  // 이름으로 찾고 한 페이지에 9개씩 보여 준다. 카드마다 연결 상태를 따로 읽으므로, 페이지를 나누면 한 번에 나가는 요청도 줄어든다.
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const toolsRef = useRef<HTMLDivElement>(null);
  const goToPage = (next: number) => { setPage(next); toolsRef.current?.scrollIntoView({ block: 'start' }); };

  /** 그 프로젝트를 고른 뒤 화면을 옮긴다. */
  async function open(projectId: string, path: string) {
    await selectProject(projectId);
    onNavigate(path);
  }

  const head = <div className="page-head">
    <div><h1>{copy.title}</h1><p>{copy.description}</p></div>
    {state.phase === 'ready' && !adding && <Keycap variant="secondary" onClick={() => setAdding(true)}>{t.setup.app.add}</Keycap>}
  </div>;

  if (state.phase === 'loading') return <>{head}<p className="dashboard-status" role="status">{copy.loading}</p></>;
  if (state.phase === 'error') return <>{head}<div className="notice error" role="alert"><strong>{copy.loadError}</strong><br />{errorMessage(state.error, t, copy.loadError)}
    <div className="page-actions"><Keycap variant="secondary" onClick={() => void refresh()}>{t.dashboard.retry}</Keycap></div></div></>;

  const showForm = adding || state.projects.length === 0;
  const needle = query.trim().toLowerCase();
  const filtered = state.projects.filter((project) => needle === '' || displayProjectName(project.name).toLowerCase().includes(needle) || project.name.toLowerCase().includes(needle));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const first = (currentPage - 1) * PAGE_SIZE;
  const visible = filtered.slice(first, first + PAGE_SIZE);
  return <>
    {head}
    {showForm && <section className="setup-card" aria-label={t.setup.app.add}>
      <div className="setup-card__body">
        <p>{state.projects.length === 0 ? t.setup.app.copy : t.setup.app.addCopy}</p>
        <ProjectNameForm onCancel={adding ? () => setAdding(false) : undefined}
          onCreate={async (name) => { const created = await createDeployProject(name); onNavigate(`/projects/${encodeURIComponent(created.id)}/settings`); }} />
      </div>
    </section>}
    {state.projects.length > 0 && <>
      <div className="dashboard-tools" role="search" ref={toolsRef}>
        <div className="aws-key-form__field dashboard-tools__search">
          <label htmlFor={searchId}>{t.dashboard.searchLabel}</label>
          <input id={searchId} type="search" value={query} placeholder={copy.searchName} autoComplete="off" spellCheck={false}
            onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
        </div>
      </div>
      <p className="dashboard-status" role="status" aria-live="polite">
        {filtered.length === 0 ? copy.noMatches : copy.showing(filtered.length, first + 1, first + visible.length)}
        {needle !== '' && <> <button type="button" className="dashboard-tools__clear" onClick={() => { setQuery(''); setPage(1); }}>{t.dashboard.clearSearch}</button></>}
      </p>
      {visible.length > 0 && <ul className="project-list" aria-label={copy.title}>
        {visible.map((project) => <ProjectCard key={project.id} project={project} selected={state.project?.id === project.id}
          onOpen={(path) => void open(project.id, path)} onNavigate={onNavigate} />)}
      </ul>}
      {pageCount > 1 && <nav className="pager" aria-label={copy.pagerLabel}>
        <Keycap variant="secondary" disabled={currentPage <= 1} onClick={() => goToPage(currentPage - 1)}>{t.dashboard.prevPage}</Keycap>
        <span className="pager__status" aria-current="page">{t.dashboard.pageOf(currentPage, pageCount)}</span>
        <Keycap variant="secondary" disabled={currentPage >= pageCount} onClick={() => goToPage(currentPage + 1)}>{t.dashboard.nextPage}</Keycap>
      </nav>}
    </>}
  </>;
}
