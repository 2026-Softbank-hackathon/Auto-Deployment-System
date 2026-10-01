import { useState } from 'react';
import { createDeployment, DeploymentApiError } from '../api/deployment-api';
import { DeployKeycap } from '../components/ui/DeployKeycap';
import type { Navigate } from '../app/navigation';
import { ActiveDeploymentsBanner } from '../features/deployment-start/ActiveDeploymentsBanner';
import { DeployReadiness } from '../features/deployment-start/DeployReadiness';
import { PipelineRail } from '../features/deployment-start/PipelineRail';
import { isDeployTarget, TargetToggle, type DeployTarget } from '../features/deployment-start/TargetToggle';
import { missingFor, useDeployProject } from '../features/deployment-start/useDeployProject';
import { ZipUploader } from '../features/deployment-start/ZipUploader';
import { errorMessage, useI18n } from '../i18n/I18nProvider';

/** 처음 골라져 있는 배포 대상 벤더(aws | onprem). 프로필은 서버가 벤더에서 고른다. */
const defaultTarget: DeployTarget = isDeployTarget(import.meta.env.VITE_DEMO_TARGET) ? import.meta.env.VITE_DEMO_TARGET : 'aws';

/** 프로젝트 이름은 처음 한 번만 정한다. 고른 ZIP 이름이 있으면 그 이름을, 없으면 app을 쓴다. 시간 접미사는 중복(409) 방지용. */
function automaticProjectName(fileName: string | undefined): string {
  const baseName = fileName?.replace(/\.zip$/i, '').trim() || 'app';
  const suffix = `-${Date.now()}`;
  return `${baseName.slice(0, 100 - suffix.length)}${suffix}`;
}

/** 배포 환경이 없어서 서버가 거절한 경우 (apps/api deployment-service resolveEnvironments). */
const environmentRequiredCodes = ['TARGET_ENVIRONMENT_REQUIRED', 'AWS_REGISTRY_ENVIRONMENT_REQUIRED'];

export function SimpleDeployPage({ onStarted, onNavigate }: { onStarted: (deploymentId: string) => void; onNavigate: Navigate }) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState<DeployTarget>(defaultTarget);
  const [error, setError] = useState<unknown>(null);
  const [isStarting, setIsStarting] = useState(false);
  const { state: projectState, refresh: refreshProject, registerAws } = useDeployProject();

  const project = projectState.phase === 'ready' ? projectState.project : null;
  const environmentsReady = projectState.phase === 'ready' && project !== null && missingFor(target, projectState.environments).length === 0;
  const canDeploy = Boolean(file) && environmentsReady;

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
      <DeployReadiness target={target} state={projectState} onRetry={() => void refreshProject()} onRegisterAws={(input) => registerAws(input, automaticProjectName(file?.name))} />
      <div className="deploy-card__footer">
        <p className={`deploy-card__hint ${canDeploy ? 'is-ready' : ''}`} aria-live="polite">{hint}</p>
        <DeployKeycap size="lg" sound="start" disabled={!canDeploy} busy={isStarting} onClick={() => void startDeployment()}>{t.deploy.button}</DeployKeycap>
      </div>
    </section>
  </>;
}
