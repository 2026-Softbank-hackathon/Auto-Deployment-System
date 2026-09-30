import { useCallback, useEffect, useRef, useState } from 'react';
import { deploymentLogSteps, getDeploymentLogs, getDeploymentStatus, type DeploymentLogStep, type DeploymentStatusResponse } from '../../api/deployment-api';
import { subscribeToDeploymentEvents, type DeploymentEvent } from '../../api/deployment-events';
import { DeploymentAnalysis } from '../analysis/DeploymentAnalysis';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import type { Messages } from '../../i18n/ko';
import { useSound } from '../sound/SoundProvider';

type ErrorState = { cause: unknown; fallback: 'statusFailed' | 'logsFailed' } | null;
type StepLog = { step: DeploymentLogStep; text: string };

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
/** 화면 상태는 배포 status만 기준으로 한다. currentStep.name은 단계 로그 이름(analyze·verify 등)이라 status와 값 체계가 다르다. */
function deploymentStatus(status: DeploymentStatusResponse | null): string | null { return text(status?.status); }
function currentStepLabel(status: DeploymentStatusResponse | null, t: Messages): string {
  const current = deploymentStatus(status);
  return current ? (t.progress.steps[current] ?? t.progress.stepUpdating) : t.progress.stepLoading;
}
function isLogStep(value: unknown): value is DeploymentLogStep { return (deploymentLogSteps as readonly unknown[]).includes(value); }
/** log.line 이벤트 한 줄을 이미 불러온 단계별 로그 뒤에 붙인다. */
function appendLogLine(logs: StepLog[], payload: unknown): StepLog[] {
  if (!payload || typeof payload !== 'object') return logs;
  const { step, line } = payload as { step?: unknown; line?: unknown };
  if (!isLogStep(step) || typeof line !== 'string') return logs;
  const existing = logs.find((entry) => entry.step === step);
  if (!existing) return [...logs, { step, text: line }].sort((a, b) => deploymentLogSteps.indexOf(a.step) - deploymentLogSteps.indexOf(b.step));
  return logs.map((entry) => (entry === existing ? { ...entry, text: `${entry.text}\n${line}` } : entry));
}
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
  const [logs, setLogs] = useState<StepLog[] | null>(null);
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
      // 로그 한 줄마다 상태를 다시 조회하지 않는다. 불러온 로그가 있으면 뒤에 붙이기만 한다.
      if (event.name === 'log.line') {
        setLogs((previous) => (previous ? appendLogLine(previous, event.payload) : previous));
        return;
      }
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
    const results = await Promise.allSettled(deploymentLogSteps.map(async (step) => ({ step, text: await getDeploymentLogs(deploymentId, step) })));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure && results.every((result) => result.status === 'rejected')) {
      setError({ cause: failure.reason, fallback: 'logsFailed' });
      return;
    }
    setLogs(results.flatMap((result) => (result.status === 'fulfilled' && result.value.text !== null ? [{ step: result.value.step, text: result.value.text }] : [])));
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
    <details className="technical-details"><summary>{t.progress.technical}</summary><button className="secondary compact" onClick={() => void loadLogs()}>{t.progress.loadLogs}</button>{logs !== null && (logs.length
      ? logs.map((entry) => <div key={entry.step} className="step-log"><strong>{t.progress.logSteps[entry.step]}</strong><pre>{entry.text}</pre></div>)
      : <p>{t.progress.noLogs}</p>)}</details>
  </section><DeploymentAnalysis deploymentId={deploymentId} deploymentStatus={currentDeploymentStatus} /></>;
}
