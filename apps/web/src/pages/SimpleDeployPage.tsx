import { useEffect, useState, type MouseEvent } from 'react';
import { createDeployment, DeploymentApiError, listProjectEnv } from '../api/deployment-api';
import { loadEnvPlan, missingEnvNames } from '../features/setup/env-plan';
import { DeployKeycap } from '../components/ui/DeployKeycap';
import { followAppLink, type Navigate } from '../app/navigation';
import { ActiveDeploymentsBanner } from '../features/deployment-start/ActiveDeploymentsBanner';
import { PipelineRail } from '../features/deployment-start/PipelineRail';
import { TargetToggle, type DeployTarget } from '../features/deployment-start/TargetToggle';
import { ProjectPickerDialog, useReadyProjects } from '../features/deployment-start/ProjectPickerDialog';
import { SetupSummary } from '../features/deployment-start/SetupSummary';
import { requestReview } from '../features/deployment-progress/review-flag';
import { usePreferences } from '../features/settings/preferences';
import { missingFor, setupStatus, useDeployProject } from '../features/deployment-start/useDeployProject';
import { ZipUploader } from '../features/deployment-start/ZipUploader';
import { errorMessage, useI18n } from '../i18n/I18nProvider';


/** 배포 환경이 없어서 서버가 거절한 경우 (apps/api deployment-service resolveEnvironments). */
const environmentRequiredCodes = ['TARGET_ENVIRONMENT_REQUIRED', 'AWS_REGISTRY_ENVIRONMENT_REQUIRED'];
/** 환경은 있지만 참조하는 AWS 키(시크릿)가 없거나 설정이 잘못돼 서버가 거절한 경우 (deployment-service 자격증명 사전 검증). */
const credentialCodes = ['AWS_CREDENTIALS_MISSING', 'AWS_CREDENTIALS_INVALID'];

export function SimpleDeployPage({ onStarted, onNavigate, onRedirect }: { onStarted: (deploymentId: string) => void; onNavigate: Navigate; /** 뒤로 가기에 남기지 않는 이동 */ onRedirect: Navigate }) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  // 처음 골라져 있는 배포할 곳과 "배포 전 확인" 여부는 환경설정의 기본값을 따른다. 이 화면에서 바꾼 것은 이번 배포에만 쓴다.
  const { preferences } = usePreferences();
  const [target, setTarget] = useState<DeployTarget>(preferences.defaultTarget);
  const [error, setError] = useState<unknown>(null);
  const [isStarting, setIsStarting] = useState(false);
  // 켜면 분석 뒤에 멈춰서 감지한 포트를 확인 · 수정한다 (#144). 기본은 꺼짐(원클릭).
  const [reviewFirst, setReviewFirst] = useState(preferences.reviewFirst);
  const { state: projectState, refresh: refreshProject, selectProject } = useDeployProject();
  const status = setupStatus(projectState);
  // 화면에 들어올 때 연결 상태를 다시 읽는다 (다른 탭이나 연결 설정 화면에서 바뀌었을 수 있다).
  useEffect(() => { void refreshProject(); }, [refreshProject]);

  // 필수 연결(AWS)이 없는 프로젝트는 고르지 않은 것으로 다룬다. 선택 모달에도 준비된 프로젝트만 나온다.
  const project = status.ready && status.awsReady ? status.project : null;
  const allProjects = status.ready ? status.projects : null;
  const readyProjects = useReadyProjects(allProjects);
  const noneReady = readyProjects !== null && readyProjects.length === 0;
  const [picking, setPicking] = useState(false);
  // 최근 배포의 분석 기준으로, 등록하지 않으면 배포가 실패하는 환경변수 개수. 새 ZIP은 다를 수 있어 배포를 막지는 않고 알리기만 한다.
  const projectId = project?.id ?? null;
  const [envMissing, setEnvMissing] = useState(0);
  useEffect(() => {
    setEnvMissing(0);
    if (!projectId) return;
    let active = true;
    Promise.all([loadEnvPlan(projectId), listProjectEnv(projectId)]).then(([plan, registered]) => {
      if (active && plan) setEnvMissing(missingEnvNames(plan, registered).length);
    }, () => { /* 안내용이라 읽지 못하면 표시하지 않는다 */ });
    return () => { active = false; };
  }, [projectId]);
  // 고른 대상에 필요한 연결이 다 됐는지. AWS 키는 어느 대상이든 필요하다(온프레미스도 이미지를 ECR에 둔다).
  const targetReady = status.ready && project !== null && missingFor(target, projectState.phase === 'ready' ? projectState.environments : []).length === 0;
  const canDeploy = Boolean(file) && targetReady;

  // 등록한 프로젝트가 하나도 없으면(처음 쓰는 경우) 내 프로젝트로 보내 프로젝트부터 만들게 한다.
  // 앱은 있는데 AWS 연결만 없을 때는 보내지 않는다. 여기서 다른 앱으로 바꿀 수 있어야 하기 때문이다.
  const needsFirstSetup = status.ready && status.projects.length === 0;
  useEffect(() => { if (needsFirstSetup) onRedirect('/projects'); }, [needsFirstSetup, onRedirect]);

  async function startDeployment() {
    if (!file || !project || !targetReady || isStarting) return;
    setIsStarting(true);
    setError(null);
    try {
      const deployment = await createDeployment(file, project.id, target);
      if (reviewFirst) requestReview(deployment.deploymentId);
      onStarted(deployment.deploymentId);
    } catch (requestError) {
      setError(requestError);
      // 그사이 환경이나 키가 바뀌었으면 연결 상태를 새로 읽는다.
      if (requestError instanceof DeploymentApiError && requestError.code && [...environmentRequiredCodes, ...credentialCodes].includes(requestError.code)) void refreshProject();
    } finally {
      setIsStarting(false);
    }
  }

  // 고른 프로젝트에 온프레미스 서버가 없는데 온프레미스를 골랐으면, 배포 버튼이 그 프로젝트의 설정으로 가는 버튼이 된다.
  const mustSetUp = status.ready && project !== null && !targetReady;
  const hint = isStarting ? t.deploy.hintStarting
    : !status.ready ? t.deploy.hintEmpty
      : noneReady ? t.deploy.hintNoneReady
        : project === null ? t.deploy.hintPickProject
          : mustSetUp ? t.deploy.hintNeedsSetup : file ? t.deploy.hintReady : t.deploy.hintEmpty;
  // 아는 거절 사유는 안내 문구로, 모르는 사유는 서버가 준 설명을 그대로 보여 준다 (숫자 코드만 보이지 않게).
  const startErrorCode = error instanceof DeploymentApiError ? error.code : undefined;
  const setupRejected = startErrorCode !== undefined && [...environmentRequiredCodes, ...credentialCodes].includes(startErrorCode);
  const startErrorCopy = setupRejected ? t.deploy.summary.rejected
    : error instanceof DeploymentApiError && error.serverMessage ? `${error.serverMessage} (${error.status})`
      : errorMessage(error, t, t.errors.startFailed);

  return <>
    <div className="page-head">
      <div><h1>{t.deploy.title}</h1><p>{t.deploy.description}</p></div>
    </div>
    <ActiveDeploymentsBanner onNavigate={onNavigate} />
    <section className="deploy-card" aria-label={t.deploy.cardLabel}>
      <PipelineRail sourceReady={Boolean(file)} />
      <ZipUploader file={file} onChange={(next) => { setFile(next); setError(null); }} disabled={isStarting} />
      {error !== null && <div className="notice error" role="alert"><strong>{t.deploy.startError}</strong><br />{startErrorCopy}</div>}
      <TargetToggle value={target} onChange={setTarget} disabled={isStarting} />
      <label className="deploy-option">
        <input type="checkbox" checked={reviewFirst} onChange={(event) => setReviewFirst(event.target.checked)} disabled={isStarting} />
        <span>{t.deploy.reviewFirst}</span>
      </label>
      <SetupSummary target={target} state={projectState} usable={project !== null} envMissing={envMissing} onRetry={() => void refreshProject()} onNavigate={onNavigate}
        onPick={() => setPicking(true)} disabled={isStarting} />
      <div className="deploy-card__footer">
        <p className={`deploy-card__hint ${canDeploy ? 'is-ready' : ''}`} aria-live="polite">{hint}</p>
        {noneReady && project === null
          ? <DeployKeycap size="lg" href="/projects" onClick={(event: MouseEvent<HTMLAnchorElement>) => followAppLink(event, onNavigate)}>{t.deploy.goProjects}</DeployKeycap>
          : mustSetUp && project
          ? <DeployKeycap size="lg" href={`/projects/${encodeURIComponent(project.id)}/settings`} onClick={(event: MouseEvent<HTMLAnchorElement>) => followAppLink(event, onNavigate)}>{t.deploy.goSetup}</DeployKeycap>
          : <DeployKeycap size="lg" sound="start" disabled={!canDeploy} busy={isStarting} onClick={() => void startDeployment()}>{t.deploy.button}</DeployKeycap>}
      </div>
    </section>
    <ProjectPickerDialog open={picking} ready={readyProjects} hiddenCount={allProjects && readyProjects ? allProjects.length - readyProjects.length : 0}
      selectedId={project?.id ?? null} onClose={() => setPicking(false)} onNavigate={onNavigate}
      onSelect={(projectId) => { setPicking(false); setError(null); void selectProject(projectId); }} />
  </>;
}
