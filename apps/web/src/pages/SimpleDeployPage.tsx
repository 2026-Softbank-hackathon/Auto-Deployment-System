import { useEffect, useRef, useState } from 'react';
import { createDeployment, DeploymentApiError } from '../api/deployment-api';
import { DeployKeycap } from '../components/ui/DeployKeycap';
import type { Navigate } from '../app/navigation';
import { ActiveDeploymentsBanner } from '../features/deployment-start/ActiveDeploymentsBanner';
import { DeployReadiness } from '../features/deployment-start/DeployReadiness';
import { PipelineRail } from '../features/deployment-start/PipelineRail';
import { SetupDialog } from '../features/deployment-start/SetupDialog';
import { isDeployTarget, TargetToggle, type DeployTarget } from '../features/deployment-start/TargetToggle';
import { missingFor, useDeployProject } from '../features/deployment-start/useDeployProject';
import { ZipUploader } from '../features/deployment-start/ZipUploader';
import { errorMessage, useI18n } from '../i18n/I18nProvider';

/** 처음 골라져 있는 배포 대상 벤더(aws | onprem). 프로필은 서버가 벤더에서 고른다. */
const defaultTarget: DeployTarget = isDeployTarget(import.meta.env.VITE_DEMO_TARGET) ? import.meta.env.VITE_DEMO_TARGET : 'aws';

/** 배포 환경이 없어서 서버가 거절한 경우 (apps/api deployment-service resolveEnvironments). */
const environmentRequiredCodes = ['TARGET_ENVIRONMENT_REQUIRED', 'AWS_REGISTRY_ENVIRONMENT_REQUIRED'];

export function SimpleDeployPage({ onStarted, onNavigate }: { onStarted: (deploymentId: string) => void; onNavigate: Navigate }) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState<DeployTarget>(defaultTarget);
  const [error, setError] = useState<unknown>(null);
  const [isStarting, setIsStarting] = useState(false);
  const { state: projectState, refresh: refreshProject, createDeployProject, registerAws } = useDeployProject();
  // 처음 설정 모달. 열 때마다 번호를 올려 새로 시작한다(0 = 닫힘).
  const [setupRound, setSetupRound] = useState(0);
  const [setupOpen, setSetupOpen] = useState(false);
  const openSetup = () => { setSetupRound((round) => round + 1); setSetupOpen(true); };

  const project = projectState.phase === 'ready' ? projectState.project : null;
  const environmentsReady = projectState.phase === 'ready' && project !== null && missingFor(target, projectState.environments).length === 0;
  const canDeploy = Boolean(file) && environmentsReady;
  const awsEnvironment = projectState.phase === 'ready' ? projectState.environments.find((environment) => environment.type === 'aws' && environment.isDefault) ?? null : null;

  // AWS 연결이 아직 없으면 화면에 들어왔을 때 처음 설정을 한 번 자동으로 띄운다. 닫으면 다시 띄우지 않는다.
  const autoOpened = useRef(false);
  const needsSetup = projectState.phase === 'ready' && awsEnvironment === null;
  useEffect(() => {
    if (!needsSetup || autoOpened.current) return;
    autoOpened.current = true;
    setSetupRound((round) => round + 1);
    setSetupOpen(true);
  }, [needsSetup]);

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
      if (requestError instanceof DeploymentApiError && requestError.code && environmentRequiredCodes.includes(requestError.code)) void refreshProject();
    } finally {
      setIsStarting(false);
    }
  }

  const hint = isStarting ? t.deploy.hintStarting : !file ? t.deploy.hintEmpty : environmentsReady ? t.deploy.hintReady : t.deploy.hintNeedsSetup;
  const startErrorCopy = error instanceof DeploymentApiError && error.code && environmentRequiredCodes.includes(error.code) ? t.deploy.readiness.environmentRequired : errorMessage(error, t, t.errors.startFailed);

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
      <DeployReadiness target={target} state={projectState} onRetry={() => void refreshProject()} onOpenSetup={openSetup} />
      <div className="deploy-card__footer">
        <p className={`deploy-card__hint ${canDeploy ? 'is-ready' : ''}`} aria-live="polite">{hint}</p>
        <DeployKeycap size="lg" sound="start" disabled={!canDeploy} busy={isStarting} onClick={() => void startDeployment()}>{t.deploy.button}</DeployKeycap>
      </div>
    </section>
    {setupOpen && <SetupDialog key={setupRound} project={project} awsEnvironment={awsEnvironment} onCreateProject={createDeployProject} onRegisterAws={registerAws} onClose={() => setSetupOpen(false)} />}
  </>;
}
