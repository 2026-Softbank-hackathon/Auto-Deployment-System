import { useState } from 'react';
import { createDeployment, createProject } from '../api/deployment-api';
import { DeployKeycap } from '../components/ui/DeployKeycap';
import type { Navigate } from '../app/navigation';
import { ActiveDeploymentsBanner } from '../features/deployment-start/ActiveDeploymentsBanner';
import { PipelineRail } from '../features/deployment-start/PipelineRail';
import { ZipUploader } from '../features/deployment-start/ZipUploader';
import { errorMessage, useI18n } from '../i18n/I18nProvider';

const demoTargetProfile = import.meta.env.VITE_DEMO_TARGET_PROFILE ?? 'aws-ecs-basic';

function automaticProjectName(fileName: string): string {
  const baseName = fileName.replace(/\.zip$/i, '').trim() || 'deployment';
  const suffix = `-${Date.now()}`;
  return `${baseName.slice(0, 100 - suffix.length)}${suffix}`;
}

export function SimpleDeployPage({ onStarted, onNavigate }: { onStarted: (deploymentId: string) => void; onNavigate: Navigate }) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isStarting, setIsStarting] = useState(false);

  async function startDeployment() {
    if (!file || isStarting) return;
    setIsStarting(true);
    setError(null);
    try {
      const project = await createProject(automaticProjectName(file.name));
      const deployment = await createDeployment(file, project.id, demoTargetProfile);
      onStarted(deployment.deploymentId);
    } catch (requestError) {
      setError(requestError);
    } finally {
      setIsStarting(false);
    }
  }

  const hint = isStarting ? t.deploy.hintStarting : file ? t.deploy.hintReady : t.deploy.hintEmpty;

  return <>
    <div className="page-head">
      <div><h1>{t.deploy.title}</h1><p>{t.deploy.description}</p></div>
    </div>
    <ActiveDeploymentsBanner onNavigate={onNavigate} />
    <section className="deploy-card" aria-label={t.deploy.cardLabel}>
      <PipelineRail sourceReady={Boolean(file)} />
      <ZipUploader file={file} onChange={(next) => { setFile(next); setError(null); }} disabled={isStarting} />
      {error !== null && <div className="notice error" role="alert"><strong>{t.deploy.startError}</strong><br />{errorMessage(error, t, t.errors.startFailed)}</div>}
      <div className="deploy-card__footer">
        <p className={`deploy-card__hint ${file ? 'is-ready' : ''}`} aria-live="polite">{hint}</p>
        <DeployKeycap size="lg" sound="start" disabled={!file} busy={isStarting} onClick={() => void startDeployment()}>{t.deploy.button}</DeployKeycap>
      </div>
    </section>
  </>;
}
