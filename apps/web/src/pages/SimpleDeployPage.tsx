import { useEffect, useRef, useState } from 'react';
import { createDeployment, DeploymentApiError } from '../api/deployment-api';
import { DeployKeycap } from '../components/ui/DeployKeycap';
import { Keycap } from '../components/ui/Keycap';
import type { Navigate } from '../app/navigation';
import { ActiveDeploymentsBanner } from '../features/deployment-start/ActiveDeploymentsBanner';
import { DeployReadiness } from '../features/deployment-start/DeployReadiness';
import { OnpremDialog } from '../features/deployment-start/OnpremDialog';
import { PipelineRail } from '../features/deployment-start/PipelineRail';
import { SetupDialog } from '../features/deployment-start/SetupDialog';
import { isDeployTarget, TargetToggle, type DeployTarget } from '../features/deployment-start/TargetToggle';
import { awsKeysMissing, missingFor, useDeployProject } from '../features/deployment-start/useDeployProject';
import { ZipUploader } from '../features/deployment-start/ZipUploader';
import { errorMessage, useI18n } from '../i18n/I18nProvider';

/** 처음 골라져 있는 배포 대상 벤더(aws | onprem). 프로필은 서버가 벤더에서 고른다. */
const defaultTarget: DeployTarget = isDeployTarget(import.meta.env.VITE_DEMO_TARGET) ? import.meta.env.VITE_DEMO_TARGET : 'aws';

/** 배포 환경이 없어서 서버가 거절한 경우 (apps/api deployment-service resolveEnvironments). */
const environmentRequiredCodes = ['TARGET_ENVIRONMENT_REQUIRED', 'AWS_REGISTRY_ENVIRONMENT_REQUIRED'];
/** 환경은 있지만 참조하는 AWS 키(시크릿)가 없거나 설정이 잘못돼 서버가 거절한 경우 (deployment-service 자격증명 사전 검증). */
const credentialCodes = ['AWS_CREDENTIALS_MISSING', 'AWS_CREDENTIALS_INVALID'];

export function SimpleDeployPage({ onStarted, onNavigate }: { onStarted: (deploymentId: string) => void; onNavigate: Navigate }) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState<DeployTarget>(defaultTarget);
  const [error, setError] = useState<unknown>(null);
  const [isStarting, setIsStarting] = useState(false);
  const { state: projectState, refresh: refreshProject, createDeployProject, registerAws, registerOnprem } = useDeployProject();
  // 온프레미스 연결 모달 (0 = 닫힘)
  const [onpremRound, setOnpremRound] = useState(0);
  const [onpremOpen, setOnpremOpen] = useState(false);
  const openOnprem = () => { setOnpremRound((round) => round + 1); setOnpremOpen(true); };
  // 처음 설정 모달. 열 때마다 번호를 올려 새로 시작한다(0 = 닫힘).
  const [setupRound, setSetupRound] = useState(0);
  const [setupOpen, setSetupOpen] = useState(false);
  const openSetup = () => { setSetupRound((round) => round + 1); setSetupOpen(true); };

  const project = projectState.phase === 'ready' ? projectState.project : null;
  const environmentsReady = projectState.phase === 'ready' && project !== null && missingFor(target, projectState.environments).length === 0
    && !awsKeysMissing(projectState.environments, projectState.secretNames);
  const canDeploy = Boolean(file) && environmentsReady;
  const onpremEnvironment = projectState.phase === 'ready' ? projectState.environments.find((environment) => environment.type === 'onprem' && environment.isDefault) ?? null : null;
  const awsEnvironment = projectState.phase === 'ready' ? projectState.environments.find((environment) => environment.type === 'aws' && environment.isDefault) ?? null : null;

  // AWS 연결이 아직 없으면 화면에 들어왔을 때 처음 설정을 한 번 자동으로 띄운다. 닫으면 다시 띄우지 않는다.
  const autoOpened = useRef(false);
  const needsSetup = projectState.phase === 'ready' && awsEnvironment === null;
  // 실패 화면의 "AWS 키 변경"으로 들어온 경우(/deploy?setup=aws)에도 한 번 연다. 새로고침 때 다시 열리지 않게 주소에서 표시를 지운다.
  const requestedSetup = useRef(new URLSearchParams(window.location.search).get('setup') === 'aws');
  const projectReady = projectState.phase === 'ready';
  useEffect(() => {
    if (!projectReady || autoOpened.current || !(needsSetup || requestedSetup.current)) return;
    autoOpened.current = true;
    if (requestedSetup.current) window.history.replaceState(null, '', window.location.pathname);
    setSetupRound((round) => round + 1);
    setSetupOpen(true);
  }, [projectReady, needsSetup]);

  async function startDeployment() {
    if (!file || !project || !environmentsReady || isStarting) return;
    setIsStarting(true);
    setError(null);
    try {
      const deployment = await createDeployment(file, project.id, target);
      onStarted(deployment.deploymentId);
    } catch (requestError) {
      setError(requestError);
      // 그사이 환경이 지워졌으면 등록 안내가 다시 보이도록 준비 상태를 새로 읽는다.
      if (requestError instanceof DeploymentApiError && requestError.code && [...environmentRequiredCodes, ...credentialCodes].includes(requestError.code)) void refreshProject();
    } finally {
      setIsStarting(false);
    }
  }

  const hint = isStarting ? t.deploy.hintStarting : !file ? t.deploy.hintEmpty : environmentsReady ? t.deploy.hintReady : t.deploy.hintNeedsSetup;
  // 아는 거절 사유는 안내 문구로, 모르는 사유는 서버가 준 설명을 그대로 보여 준다 (숫자 코드만 보이지 않게).
  const startErrorCode = error instanceof DeploymentApiError ? error.code : undefined;
  const environmentRejected = startErrorCode !== undefined && environmentRequiredCodes.includes(startErrorCode);
  const credentialRejected = startErrorCode !== undefined && credentialCodes.includes(startErrorCode);
  const startErrorCopy = environmentRejected ? t.deploy.readiness.environmentRequired
    : credentialRejected ? t.deploy.readiness.credentialRejected
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
      {error !== null && <div className="notice error" role="alert"><strong>{t.deploy.startError}</strong><br />{startErrorCopy}
        {credentialRejected && <div><Keycap variant="secondary" aria-haspopup="dialog" onClick={openSetup}>{t.deploy.readiness.keysMissingAction}</Keycap></div>}
      </div>}
      <TargetToggle value={target} onChange={setTarget} disabled={isStarting} />
      <DeployReadiness target={target} state={projectState} onRetry={() => void refreshProject()} onOpenSetup={openSetup} onOpenOnprem={openOnprem} />
      <div className="deploy-card__footer">
        <p className={`deploy-card__hint ${canDeploy ? 'is-ready' : ''}`} aria-live="polite">{hint}</p>
        <DeployKeycap size="lg" sound="start" disabled={!canDeploy} busy={isStarting} onClick={() => void startDeployment()}>{t.deploy.button}</DeployKeycap>
      </div>
    </section>
    {setupOpen && <SetupDialog key={setupRound} project={project} awsEnvironment={awsEnvironment} onCreateProject={createDeployProject} onRegisterAws={registerAws} onClose={() => setSetupOpen(false)} />}
    {onpremOpen && <OnpremDialog key={onpremRound} environment={onpremEnvironment} onRegisterHost={registerOnprem} onClose={() => setOnpremOpen(false)} />}
  </>;
}
