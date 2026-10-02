import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import { createDeployment, DeploymentApiError, listEnvironments, listProjectEnv, type EnvironmentSummary } from '../api/deployment-api';
import { loadEnvPlan, missingEnvNames } from '../features/setup/env-plan';
import { DeployKeycap } from '../components/ui/DeployKeycap';
import { followAppLink, type Navigate } from '../app/navigation';
import { ActiveDeploymentsBanner } from '../features/deployment-start/ActiveDeploymentsBanner';
import { AppChooser, findAppByName, suggestAppName, type AppChoice } from '../features/deployment-start/AppChooser';
import { ConnectionPicker, type ConnectionOption } from '../features/deployment-start/ConnectionPicker';
import { PipelineRail } from '../features/deployment-start/PipelineRail';
import { useDeployProject, type DeployProject } from '../features/deployment-start/useDeployProject';
import { ZipUploader } from '../features/deployment-start/ZipUploader';
import { useSharedConnections } from '../features/connections/useSharedConnections';
import { loadProjects } from '../features/dashboard/useProjectList';
import { requestReview } from '../features/deployment-progress/review-flag';
import { usePreferences } from '../features/settings/preferences';
import { errorMessage, useI18n } from '../i18n/I18nProvider';

/** 고른 연결을 쓸 수 없어 서버가 거절한 경우 (apps/api deployment-service resolveEnvironments · 자격증명 사전 검증). */
const connectionRejectedCodes = ['TARGET_ENVIRONMENT_REQUIRED', 'AWS_REGISTRY_ENVIRONMENT_REQUIRED', 'AWS_CREDENTIALS_MISSING', 'AWS_CREDENTIALS_INVALID', 'NOT_FOUND'];

/** 주소의 ?project= 로 기존 앱을 골라서 들어온 경우 (대시보드 · 프로젝트 상세의 "이 앱으로 배포") */
function requestedProjectId(): string | null {
  return new URLSearchParams(window.location.search).get('project');
}

/**
 * 간단 배포 (#218): ZIP을 올리고 → 앱(새 앱 또는 기존 앱)과 배포할 연결을 고르고 → 한 번 누른다.
 * 새 앱은 배포하기를 누를 때 만든다. 연결은 연결 화면에서 한 번만 등록한 공용 연결을 고른다.
 */
export function SimpleDeployPage({ onStarted, onNavigate }: { onStarted: (deploymentId: string) => void; onNavigate: Navigate }) {
  const { t } = useI18n();
  const copy = t.deploy;
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<{ kind: 'app' | 'deploy'; error: unknown } | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  // 처음 골라져 있는 연결의 종류와 "배포 전 확인" 여부는 환경설정의 기본값을 따른다. 이 화면에서 바꾼 것은 이번 배포에만 쓴다.
  const { preferences } = usePreferences();
  // 켜면 분석 뒤에 멈춰서 감지한 포트를 확인 · 수정한다 (#144). 기본은 꺼짐(원클릭).
  const [reviewFirst, setReviewFirst] = useState(preferences.reviewFirst);
  const { createDeployProject } = useDeployProject();

  // ── 앱 ──
  const [projects, setProjects] = useState<DeployProject[] | null>(null);
  const [projectsError, setProjectsError] = useState<unknown>(null);
  const loadApps = useCallback(() => {
    setProjectsError(null);
    loadProjects().then((items) => setProjects(items.map(({ id, name }) => ({ id, name }))), (loadError) => setProjectsError(loadError));
  }, []);
  useEffect(() => { loadApps(); }, [loadApps]);

  const [choice, setChoice] = useState<AppChoice>(() => {
    const requested = requestedProjectId();
    return requested ? { mode: 'existing', projectId: requested } : { mode: 'new', name: '' };
  });
  /** 사용자가 앱 칸을 직접 바꿨는지. 바꾸지 않았으면 ZIP을 올릴 때 이름으로 앱을 정해 준다. */
  const [appTouched, setAppTouched] = useState(() => requestedProjectId() !== null);
  const [nameEdited, setNameEdited] = useState(false);
  const selectedProject = choice.mode === 'existing' && projects ? projects.find((project) => project.id === choice.projectId) ?? null : null;
  const newName = choice.mode === 'new' ? choice.name.trim() : '';
  const appReady = choice.mode === 'new' ? newName !== '' && findAppByName(projects, newName) === null : selectedProject !== null;

  function chooseFile(next: File | null) {
    setFile(next);
    setError(null);
    if (!next) return;
    const suggested = suggestAppName(next.name);
    if (!appTouched) {
      // 같은 이름의 앱이 있으면 그 앱의 새 버전으로 본다.
      const match = findAppByName(projects, suggested);
      setChoice(match ? { mode: 'existing', projectId: match.id } : { mode: 'new', name: suggested });
    } else if (choice.mode === 'new' && !nameEdited) {
      setChoice({ mode: 'new', name: suggested });
    }
  }

  // 앱 목록보다 ZIP을 먼저 올렸으면, 목록이 온 뒤에 같은 이름의 앱을 찾아 그 앱으로 맞춘다.
  useEffect(() => {
    if (appTouched || choice.mode !== 'new') return;
    const match = findAppByName(projects, choice.name);
    if (match) setChoice({ mode: 'existing', projectId: match.id });
  }, [projects, appTouched, choice]);

  function changeApp(next: AppChoice, edited: 'mode' | 'name' | 'pick') {
    setAppTouched(true);
    setError(null);
    if (edited === 'name') setNameEdited(true);
    // 새 앱으로 바꾸면 올린 ZIP의 이름을 다시 채운다.
    if (edited === 'mode' && next.mode === 'new') { setNameEdited(false); next = { mode: 'new', name: file ? suggestAppName(file.name) : '' }; }
    setChoice(next);
  }

  // 고른 앱의 최근 분석 기준으로, 등록하지 않으면 배포가 실패하는 환경변수 개수. 새 ZIP은 다를 수 있어 배포를 막지는 않고 알리기만 한다.
  const selectedProjectId = selectedProject?.id ?? null;
  const [envMissing, setEnvMissing] = useState(0);
  // 고른 앱에만 묶인 예전 연결 (공용 연결 이전에 앱마다 등록한 것)
  const [appConnections, setAppConnections] = useState<EnvironmentSummary[]>([]);
  useEffect(() => {
    setEnvMissing(0);
    setAppConnections([]);
    if (!selectedProjectId) return;
    let active = true;
    Promise.all([loadEnvPlan(selectedProjectId), listProjectEnv(selectedProjectId)]).then(([plan, registered]) => {
      if (active && plan) setEnvMissing(missingEnvNames(plan, registered).length);
    }, () => { /* 안내용이라 읽지 못하면 표시하지 않는다 */ });
    listEnvironments(selectedProjectId).then((items) => { if (active) setAppConnections(items); }, () => { /* 없으면 공용 연결만 보여 준다 */ });
    return () => { active = false; };
  }, [selectedProjectId]);

  // ── 연결 ──
  const { state: connectionState, refresh: refreshConnections, retry: retryConnections } = useSharedConnections();
  const shared = connectionState.phase === 'ready' ? connectionState.connections : null;
  const all = shared ? [...shared, ...appConnections] : null;
  // 온프레미스로 배포할 때도 이미지는 AWS 계정의 저장소(ECR)에 둔다. 서버는 앱의 기본 AWS 연결, 없으면 공용 기본 AWS 연결을 쓴다.
  const registryAvailable = all !== null && all.some((connection) => connection.type === 'aws' && connection.isDefault);
  const options: ConnectionOption[] | null = all && [...all]
    .sort((a, b) => Number(b.shared) - Number(a.shared) || (a.type === b.type ? 0 : a.type === 'aws' ? -1 : 1))
    .map((connection) => ({
      connection,
      disabledReason: connection.type !== 'onprem' ? null
        : !registryAvailable ? copy.connection.needsAws
          : connection.agentOnline ? null
            : connection.agentLastSeenAt ? copy.connection.offline : copy.connection.notRegistered,
    }));
  const enabled = (options ?? []).filter((option) => option.disabledReason === null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  // 직접 고르기 전에는 설정의 기본 배포할 곳과 같은 종류의 첫 연결(기본 연결 먼저)을 골라 둔다.
  // 그 종류의 연결이 있는데 지금 쓸 수 없으면(오프라인 등) 다른 종류로 대신 고르지 않는다. 그 종류가 아예 없을 때만 다른 연결을 고른다.
  // 직접 고른 연결을 쓸 수 없게 되어도 다른 연결로 몰래 바꾸지 않고 다시 고르게 한다.
  const preferredType = preferences.defaultTarget;
  const autoPick = enabled.find((option) => option.connection.type === preferredType && option.connection.isDefault)
    ?? enabled.find((option) => option.connection.type === preferredType)
    ?? ((options ?? []).some((option) => option.connection.type === preferredType) ? null : enabled[0] ?? null);
  const selected = connectionId !== null ? enabled.find((option) => option.connection.id === connectionId) ?? null : autoPick;
  const noConnections = options !== null && options.length === 0;

  const canDeploy = Boolean(file) && appReady && selected !== null && !isStarting;

  async function startDeployment() {
    if (!file || !appReady || !selected || isStarting) return;
    setIsStarting(true);
    setError(null);
    try {
      let projectId: string;
      if (choice.mode === 'new') {
        try {
          const created = await createDeployProject(newName);
          projectId = created.id;
        } catch (createError) {
          setError({ kind: 'app', error: createError });
          return;
        }
        // 앱은 만들어졌으니, 배포가 실패해 다시 누르더라도 같은 앱을 또 만들지 않게 기존 앱으로 바꿔 둔다.
        setProjects((current) => [{ id: projectId, name: newName }, ...(current ?? [])]);
        setChoice({ mode: 'existing', projectId });
        setAppTouched(true);
      } else {
        projectId = selectedProject!.id;
      }
      const deployment = await createDeployment(file, projectId, selected.connection.id);
      if (reviewFirst) requestReview(deployment.deploymentId);
      onStarted(deployment.deploymentId);
    } catch (requestError) {
      setError({ kind: 'deploy', error: requestError });
      // 그사이 연결이 지워졌거나 키가 바뀌었으면 연결 목록을 새로 읽는다.
      if (requestError instanceof DeploymentApiError && requestError.code && connectionRejectedCodes.includes(requestError.code)) void refreshConnections();
    } finally {
      setIsStarting(false);
    }
  }

  const hint = isStarting ? copy.hintStarting
    : noConnections ? copy.hintNoConnections
      : !file ? copy.hintEmpty
        : !appReady ? (choice.mode === 'new' ? copy.hintNeedsName : copy.hintPickApp)
          : !selected ? copy.hintPickConnection : copy.hintReady;
  // 아는 거절 사유는 안내 문구로, 모르는 사유는 서버가 준 설명을 그대로 보여 준다 (숫자 코드만 보이지 않게).
  const errorCopy = (() => {
    if (!error) return null;
    const cause = error.error;
    if (error.kind === 'app') return cause instanceof DeploymentApiError && cause.status === 409 ? copy.app.nameTaken : errorMessage(cause, t, copy.app.createError);
    if (cause instanceof DeploymentApiError && cause.code && connectionRejectedCodes.includes(cause.code)) return copy.startRejected;
    return cause instanceof DeploymentApiError && cause.serverMessage ? `${cause.serverMessage} (${cause.status})` : errorMessage(cause, t, t.errors.startFailed);
  })();

  return <>
    <div className="page-head">
      <div><h1>{copy.title}</h1><p>{copy.description}</p></div>
    </div>
    <ActiveDeploymentsBanner onNavigate={onNavigate} />
    <section className="deploy-card" aria-label={copy.cardLabel}>
      <PipelineRail sourceReady={Boolean(file)} />
      <ZipUploader file={file} onChange={chooseFile} disabled={isStarting} />
      <AppChooser projects={projects} loadError={projectsError} onRetry={loadApps} value={choice} onChange={changeApp}
        envMissing={envMissing} disabled={isStarting} onNavigate={onNavigate} />
      <ConnectionPicker options={options} loadError={connectionState.phase === 'error' ? connectionState.error : null} onRetry={retryConnections}
        selectedId={selected?.connection.id ?? null} onSelect={setConnectionId} now={connectionState.phase === 'ready' ? connectionState.loadedAt : Date.now()}
        disabled={isStarting} onNavigate={onNavigate} />
      <label className="deploy-option">
        <input type="checkbox" checked={reviewFirst} onChange={(event) => setReviewFirst(event.target.checked)} disabled={isStarting} />
        <span>{copy.reviewFirst}</span>
      </label>
      {errorCopy !== null && <div className="notice error" role="alert"><strong>{error?.kind === 'app' ? copy.app.createError : copy.startError}</strong><br />{errorCopy}</div>}
      <div className="deploy-card__footer">
        <p className={`deploy-card__hint ${canDeploy ? 'is-ready' : ''}`} aria-live="polite">{hint}</p>
        {noConnections
          ? <DeployKeycap size="lg" href="/connections" onClick={(event: MouseEvent<HTMLAnchorElement>) => followAppLink(event, onNavigate)}>{copy.connection.goConnections}</DeployKeycap>
          : <DeployKeycap size="lg" sound="start" disabled={!canDeploy} busy={isStarting} onClick={() => void startDeployment()}>{copy.button}</DeployKeycap>}
      </div>
    </section>
  </>;
}
