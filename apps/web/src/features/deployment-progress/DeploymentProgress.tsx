import { useCallback, useEffect, useRef, useState } from 'react';
import { getDeploymentLogs, getDeploymentStatus, type DeploymentStatusResponse } from '../../api/deployment-api';
import { subscribeToDeploymentEvents, type DeploymentEvent } from '../../api/deployment-events';
import { DeploymentAnalysis } from '../analysis/DeploymentAnalysis';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import type { Messages } from '../../i18n/ko';
import { useSound } from '../sound/SoundProvider';

type ErrorState = { cause: unknown; fallback: 'statusFailed' | 'logsFailed' } | null;

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
function stepName(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return text((value as { name?: unknown }).name);
}
function currentStepLabel(status: DeploymentStatusResponse | null, t: Messages): string {
  const step = stepName(status?.currentStep) ?? text(status?.status);
  return step ? (t.progress.steps[step] ?? t.progress.stepUpdating) : t.progress.stepLoading;
}
function deploymentStatus(status: DeploymentStatusResponse | null): string | null { return stepName(status?.currentStep) ?? text(status?.status); }
function isSucceeded(status: DeploymentStatusResponse | null): boolean { return deploymentStatus(status) === 'succeeded'; }
function isFailed(status: DeploymentStatusResponse | null): boolean { return deploymentStatus(status) === 'failed'; }
function pipelineIndex(status: string | null): number {
  if (status === 'succeeded') return 6;
  if (status === 'verifying') return 5;
  if (status === 'provisioning' || status === 'deploying') return 4;
  if (status === 'planning' || status === 'awaiting_plan_approval') return 3;
  if (status === 'building') return 2;
  if (status === 'awaiting_target_confirmation' || status === 'queued') return 1;
  return 0;
}

export function DeploymentProgress({ deploymentId, onSucceeded }: { deploymentId: string; onSucceeded?: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<DeploymentStatusResponse | null>(null);
  const [events, setEvents] = useState<DeploymentEvent[]>([]);
  const [logs, setLogs] = useState<string | null>(null);
  const [error, setError] = useState<ErrorState>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const nextStatus = await getDeploymentStatus(deploymentId);
      setStatus(nextStatus);
      setError(null);
    } catch (requestError) {
      setError({ cause: requestError, fallback: 'statusFailed' });
    } finally { setLoading(false); }
  }, [deploymentId]);

  useEffect(() => {
    void refresh();
    return subscribeToDeploymentEvents(deploymentId, (event) => {
      setEvents((previous) => [event, ...previous].slice(0, 5));
      void refresh();
    }, () => { /* The server closes SSE after succeeded/failed; HTTP remains authoritative. */ });
  }, [deploymentId, refresh]);

  useEffect(() => {
    if (isSucceeded(status)) onSucceeded?.();
  }, [onSucceeded, status]);

  // 효과음은 이 화면에서 진행 중 → 성공/실패로 바뀌는 순간에만 낸다 (처음부터 끝난 배포를 열 때는 조용히).
  const { play } = useSound();
  const previousStatus = useRef<string | null>(null);
  useEffect(() => {
    const current = deploymentStatus(status);
    const previous = previousStatus.current;
    previousStatus.current = current;
    if (!previous || previous === current || previous === 'succeeded' || previous === 'failed') return;
    if (current === 'succeeded') play('success');
    if (current === 'failed') play('failure');
  }, [play, status]);

  const targetUrl = text(status?.publicUrl);
  const currentDeploymentStatus = deploymentStatus(status);
  async function loadLogs() {
    try { setLogs(await getDeploymentLogs(deploymentId)); }
    catch (logError) { setError({ cause: logError, fallback: 'logsFailed' }); }
  }

  if (loading) return <section className="panel"><h2>{t.progress.heading}</h2><p>{t.progress.checking}</p></section>;
  return <><section className={`panel deployment-progress ${isSucceeded(status) ? 'success' : ''} ${isFailed(status) ? 'failure' : ''}`}>
    <div className="panel-title"><div><h2>{currentStepLabel(status, t)}</h2><p>{t.progress.deploymentId}: <code>{deploymentId}</code></p></div><button className="secondary compact" onClick={() => void refresh()}>{t.progress.refresh}</button></div>
    {error && <div className="notice error"><strong>{t.progress.statusError}</strong><br />{errorMessage(error.cause, t, t.errors[error.fallback])}</div>}
    {!error && <ol className="steps deployment-steps">{t.progress.pipeline.map((step, index) => <li className={index <= pipelineIndex(currentDeploymentStatus) ? 'done' : ''} key={step}>{index + 1}<em>{step}</em></li>)}</ol>}
    {Boolean(status?.approvalPending) && <div className="notice"><strong>{t.progress.approvalTitle}</strong><br />{t.progress.approvalCopy}</div>}
    {isSucceeded(status) && targetUrl && <a className="primary open-url" href={targetUrl} target="_blank" rel="noreferrer">{t.progress.openApp}</a>}
    {isFailed(status) && <p>{t.progress.failedCopy}</p>}
    <div className="activity"><strong>{t.progress.recent}</strong>{events.length ? <ul>{events.map((event) => <li key={`${event.name}-${event.receivedAt.getTime()}`}><span>{t.progress.events[event.name]}</span><time>{event.receivedAt.toLocaleTimeString(t.locale)}</time></li>)}</ul> : <p>{t.progress.waitingEvents}</p>}</div>
    <details className="technical-details"><summary>{t.progress.technical}</summary><button className="secondary compact" onClick={() => void loadLogs()}>{t.progress.loadLogs}</button>{logs !== null && <pre>{logs || t.progress.noLogs}</pre>}</details>
  </section><DeploymentAnalysis deploymentId={deploymentId} deploymentStatus={currentDeploymentStatus} /></>;
}
