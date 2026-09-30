import { useCallback, useEffect, useRef, useState } from 'react';
import { deploymentLogSteps, getDeploymentLogs, getDeploymentStatus, getProject, type DeploymentLogStep, type DeploymentStatusResponse } from '../../api/deployment-api';
import { subscribeToDeploymentEvents } from '../../api/deployment-events';
import { GadgetIcon } from '../../components/ui/GadgetIcon';
import { Keycap } from '../../components/ui/Keycap';
import { StatusTape } from '../../components/ui/StatusTape';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import type { Messages } from '../../i18n/ko';
import { DeploymentAnalysis } from '../analysis/DeploymentAnalysis';
import { displayProjectName, elapsed } from '../dashboard/format';
import { deploymentStatusView, railStages, type DeploymentStatusView } from '../deployment-status/status-view';
import { useSound } from '../sound/SoundProvider';
import { DeployScene } from './DeployScene';

type ErrorState = { cause: unknown; fallback: 'statusFailed' | 'logsFailed' } | null;
type StepLog = { step: DeploymentLogStep; text: string };

/** 성공 후 결과 화면으로 넘어가기 전, 코로가 컵에 착지하는 모습을 보여 주는 시간 */
const SUCCESS_LANDING_MS = 1400;

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
/** 화면 상태는 배포 status만 기준으로 한다. currentStep.name은 단계 로그 이름(analyze·verify 등)이라 status와 값 체계가 다르다. */
function deploymentStatus(status: DeploymentStatusResponse | null): string | null { return text(status?.status); }
function currentStepLabel(status: string | null, t: Messages): string {
  return status ? (t.progress.steps[status] ?? t.progress.stepUpdating) : t.progress.stepLoading;
}
function isLogStep(value: unknown): value is DeploymentLogStep { return (deploymentLogSteps as readonly unknown[]).includes(value); }
function readLogLine(payload: unknown): { step: DeploymentLogStep; line: string } | null {
  if (!payload || typeof payload !== 'object') return null;
  const { step, line } = payload as { step?: unknown; line?: unknown };
  return isLogStep(step) && typeof line === 'string' ? { step, line } : null;
}
/** log.line 이벤트 한 줄을 이미 불러온 단계별 로그 뒤에 붙인다. */
function appendLogLine(logs: StepLog[], entry: { step: DeploymentLogStep; line: string }): StepLog[] {
  const existing = logs.find((log) => log.step === entry.step);
  if (!existing) return [...logs, { step: entry.step, text: entry.line }].sort((a, b) => deploymentLogSteps.indexOf(a.step) - deploymentLogSteps.indexOf(b.step));
  return logs.map((log) => (log === existing ? { ...log, text: `${log.text}\n${entry.line}` } : log));
}
/** 로그 줄 앞의 "[ISO 시각]"으로 가장 최근 줄을 고른다. */
function lineTime(line: string): number { return Date.parse(line.match(/^\[([^\]]+)\]/)?.[1] ?? '') || 0; }

/** 진행 중일 때만 1초마다 다시 그린다. 경과 시간은 서버의 createdAt 기준 실제 값이다. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function StageChips({ view }: { view: DeploymentStatusView }) {
  const { t } = useI18n();
  return <ol className="stage-chips" aria-label={t.run.chipsLabel}>
    {railStages.map((stage, index) => {
      const done = view.stage !== null && index < view.stage;
      const current = view.outcome === 'active' && view.stage === index;
      const state = done ? 'done' : current ? 'current' : 'pending';
      const note = done ? t.run.chipDone : current ? (view.waiting ? t.run.chipWaiting : t.run.chipCurrent) : t.run.chipPending;
      return <li key={stage} className={`stage-chip is-${state}`} aria-current={current ? 'step' : undefined}>
        <GadgetIcon kind={stage} size={18} />
        <span>{t.stages[stage]}</span>
        <span className="stage-chip__note">{done ? `✓ ${note}` : note}</span>
      </li>;
    })}
  </ol>;
}

interface DeploymentProgressProps { deploymentId: string; onSucceeded?: () => void; onNewDeployment?: () => void }

export function DeploymentProgress({ deploymentId, onSucceeded, onNewDeployment }: DeploymentProgressProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<DeploymentStatusResponse | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [latestLine, setLatestLine] = useState<string | null>(null);
  const [logs, setLogs] = useState<StepLog[] | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
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
      // 로그 한 줄마다 상태를 다시 조회하지 않는다. 작업 노트와 펼친 로그에만 붙인다.
      if (event.name === 'log.line') {
        const entry = readLogLine(event.payload);
        if (!entry) return;
        setLatestLine(entry.line);
        setLogs((previous) => (previous ? appendLogLine(previous, entry) : previous));
        return;
      }
      void refresh();
    }, () => { /* The server closes SSE after succeeded/failed; HTTP remains authoritative. */ });
  }, [deploymentId, refresh]);

  // 작업 노트 첫 줄 — 단계별 마지막 로그 한 줄씩 받아 가장 최근 것을 쓴다.
  useEffect(() => {
    let active = true;
    void Promise.allSettled(deploymentLogSteps.map((step) => getDeploymentLogs(deploymentId, step, 1))).then((results) => {
      if (!active) return;
      const lines = results.flatMap((result) => (result.status === 'fulfilled' && result.value ? [result.value.trim().split('\n').pop() ?? ''] : [])).filter(Boolean);
      const newest = lines.sort((a, b) => lineTime(b) - lineTime(a))[0];
      if (newest) setLatestLine((current) => current ?? newest);
    });
    return () => { active = false; };
  }, [deploymentId]);

  const projectId = text(status?.projectId);
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    getProject(projectId).then((project) => { if (active) setProjectName(project.name); }, () => { /* 이름은 없어도 진행 화면은 동작한다 */ });
    return () => { active = false; };
  }, [projectId]);

  const currentStatus = deploymentStatus(status);
  const view = deploymentStatusView(currentStatus ?? 'received');

  // 진행 중 → 성공/실패로 바뀌는 순간에만 효과음. 성공이면 코로가 컵에 착지하는 걸 보여 준 뒤 결과 화면으로 넘어간다.
  const { play } = useSound();
  const onSucceededRef = useRef(onSucceeded);
  useEffect(() => { onSucceededRef.current = onSucceeded; }, [onSucceeded]);
  const previousStatus = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = currentStatus;
    const transitioned = Boolean(previous) && previous !== currentStatus && previous !== 'succeeded' && previous !== 'failed';
    if (transitioned && currentStatus === 'failed') play('failure');
    if (currentStatus !== 'succeeded') return;
    if (!transitioned) { onSucceededRef.current?.(); return; }
    play('success');
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const timer = window.setTimeout(() => onSucceededRef.current?.(), reduced ? 0 : SUCCESS_LANDING_MS);
    return () => window.clearTimeout(timer);
  }, [currentStatus, play]);

  const now = useNow(view.outcome === 'active');
  const createdAt = text(status?.createdAt);
  const finishedAt = text(status?.succeededAt) ?? text(status?.failedAt);
  const elapsedText = createdAt ? elapsed(createdAt, finishedAt ? Date.parse(finishedAt) : now) : null;
  const title = view.outcome === 'active' ? t.run.titleActive : view.outcome === 'success' ? t.run.titleSucceeded : view.outcome === 'failed' ? t.run.titleFailed : t.run.titleStopped;
  const failureMessage = text(status?.error);

  async function loadLogs() {
    const results = await Promise.allSettled(deploymentLogSteps.map(async (step) => ({ step, text: await getDeploymentLogs(deploymentId, step) })));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure && results.every((result) => result.status === 'rejected')) {
      setError({ cause: failure.reason, fallback: 'logsFailed' });
      return;
    }
    setLogs(results.flatMap((result) => (result.status === 'fulfilled' && result.value.text !== null ? [{ step: result.value.step, text: result.value.text }] : [])));
  }

  function toggleLogs() {
    const next = !logsOpen;
    setLogsOpen(next);
    if (next && logs === null) void loadLogs();
  }

  if (loading) return <section className="panel"><h2>{t.progress.heading}</h2><p>{t.progress.checking}</p></section>;

  return <>
    <section className={`run-stage is-${view.outcome}`} aria-labelledby="run-title">
      <div className="run-head" aria-live="polite">
        <div className="run-head__title">
          <StatusTape tone={view.tone} className="run-tape">
            {view.outcome === 'active' && !view.waiting && <span className="run-tape__track" aria-hidden="true"><span className="run-tape__marble" /></span>}
            {view.tape}
          </StatusTape>
          <h1 id="run-title">{title}</h1>
          {elapsedText && <span className="run-head__elapsed" aria-label={`${t.run.elapsedLabel} ${elapsedText}`}>{elapsedText}</span>}
        </div>
        <p className="run-head__meta">
          <span>{currentStepLabel(currentStatus, t)}</span>
          <span className="run-head__id">{projectName ? `${displayProjectName(projectName)} · ` : ''}{t.dashboard.deploymentNo(deploymentId)}</span>
        </p>
      </div>

      <StageChips view={view} />

      {error && <div className="notice error" role="alert"><strong>{t.progress.statusError}</strong><br />{errorMessage(error.cause, t, t.errors[error.fallback])}</div>}

      <figure className="run-scene"><DeployScene view={view} /></figure>

      {view.outcome === 'failed' && <div className="notice error run-failure" role="alert">
        <strong>{t.run.failedCause}</strong>
        <p>{failureMessage ?? t.progress.failedCopy}</p>
        {onNewDeployment && <Keycap variant="secondary" onClick={onNewDeployment}>{t.run.newDeploy}</Keycap>}
      </div>}
      {view.outcome === 'success' && text(status?.publicUrl) && <a className="primary open-url" href={text(status?.publicUrl) ?? undefined} target="_blank" rel="noreferrer">{t.progress.openApp}</a>}
    </section>

    <section className="work-note" aria-label={t.run.workNote}>
      <div className="work-note__bar">
        <h2>{t.run.workNote}</h2>
        <p className="work-note__line">{latestLine ?? t.run.noNote}</p>
        <div className="work-note__actions">
          <Keycap variant="ghost" onClick={() => void refresh()}>{t.progress.refresh}</Keycap>
          <Keycap variant="secondary" aria-expanded={logsOpen} aria-controls="work-note-logs" onClick={toggleLogs}>{logsOpen ? t.run.collapse : t.run.expand}</Keycap>
        </div>
      </div>
      {logsOpen && <div id="work-note-logs" className="work-note__logs">
        {logs === null ? <p>{t.progress.stepLoading}</p>
          : logs.length ? logs.map((entry) => <div key={entry.step} className="step-log"><strong>{t.progress.logSteps[entry.step]}</strong><pre>{entry.text}</pre></div>)
            : <p>{t.progress.noLogs}</p>}
      </div>}
    </section>

    <DeploymentAnalysis deploymentId={deploymentId} deploymentStatus={currentStatus} />
  </>;
}
