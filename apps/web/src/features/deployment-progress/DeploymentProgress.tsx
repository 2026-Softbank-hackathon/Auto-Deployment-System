import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { approveDeploymentGate, DeploymentApiError, type ApprovalGate, deploymentLogSteps, getDeploymentAnalysisReport, getDeploymentIr, getDeploymentLogs, getDeploymentStatus, getProject, listProjectDeployments, type DeploymentLogStep, type ProjectDeploymentSummary, type DeploymentStatusResponse } from '../../api/deployment-api';
import { subscribeToDeploymentEvents } from '../../api/deployment-events';
import { GadgetIcon } from '../../components/ui/GadgetIcon';
import { Keycap } from '../../components/ui/Keycap';
import { StatusTape } from '../../components/ui/StatusTape';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import type { Messages } from '../../i18n/ko';
import { DeploymentAnalysis } from '../analysis/DeploymentAnalysis';
import { displayProjectName, elapsed, hostOf, safeHttpUrl } from '../dashboard/format';
import { deploymentStatusView, railStages, type DeploymentStatusView } from '../deployment-status/status-view';
import { useSound } from '../sound/SoundProvider';
import { awsSceneStage, DeployScene, houseFloors, koroSpot, SCENE_SIZE, sceneBox, sceneTarget } from './DeployScene';
import { deployStory, previousLive, readReusedFrom } from './deploy-story';
import { koroIdle, koroLine, sceneCue, readAnalysisFacts, type AnalysisFacts } from './koro-talk';
import { PreDeployPanel, type DetectedPort, type PreDeployReview } from './PreDeployPanel';
import { clearReview, reviewRequested } from './review-flag';
import { FailureDetail } from './FailureDetail';
import { failureKind, fixableByAwsKey, parseFailure } from './failure-reason';
import { followAppLink, type Navigate } from '../../app/navigation';
import type { DeploymentTab } from '../../app/routes';
import { RedeployButton } from './RedeployButton';
import { FailureDiagnosis } from './FailureDiagnosis';
import { CancelDeployment } from './CancelDeployment';
import { HealthProgress } from './HealthProgress';

type ErrorState = { cause: unknown; fallback: 'statusFailed' | 'logsFailed' } | null;
type StepLog = { step: DeploymentLogStep; text: string };

/** 승인 기록에 남기는 메모 — 사람이 누른 승인과 구분한다. */
const AUTO_APPROVAL_NOTE = 'one-click auto-approval (web)';
/** 사용자 입력 없이 통과시키는 승인 대기 상태 → 게이트 */
// plan 승인은 서버가 빌드 직후 자동으로 처리한다 (apps/worker handlers/build.ts autoApprovePlanAndQueueProvision). 프론트는 대상 확인만 호출한다.
const autoApprovalGates: Record<string, ApprovalGate> = { awaiting_target_confirmation: 'target' };

/** 지켜보던 배포가 성공했을 때, 결과 화면으로 넘어가기 전 코로가 컵에 착지하는 모습을 보여 주는 시간 */
const SUCCESS_LANDING_MS = 1400;

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }
/** 화면 상태는 배포 status만 기준으로 한다. currentStep.name은 단계 로그 이름(analyze·verify 등)이라 status와 값 체계가 다르다. */
function deploymentStatus(status: DeploymentStatusResponse | null): string | null { return text(status?.status); }
/** IR에서 포트가 필요한 서비스(http · worker)와 감지된 포트를 꺼낸다. */
function detectedPorts(ir: unknown): DetectedPort[] {
  const services = ir && typeof ir === 'object' ? (ir as { services?: unknown }).services : null;
  if (!services || typeof services !== 'object') return [];
  return Object.entries(services as Record<string, unknown>).flatMap(([service, value]): DetectedPort[] => {
    if (!value || typeof value !== 'object') return [];
    const { type, port } = value as { type?: unknown; port?: unknown };
    if (type !== 'http' && type !== 'worker' && typeof port !== 'number') return [];
    return [{ service, port: typeof port === 'number' ? port : null }];
  });
}

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
/** 진행 탭의 "지금" 자리에 보여 주는 최근 로그 줄 수 (좁은 화면에서는 마지막 한 줄만 보인다) */
const RECENT_LINES = 3;
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

function StageChips({ view, currentElapsed, skipped = 0 }: { view: DeploymentStatusView; /** 지금 단계에서 흐른 시간 (서버가 단계 시작 시각을 줬을 때만) */ currentElapsed: string | null; /** 앞에서부터 건너뛴 단계 수 — 이미지를 재사용하는 배포는 분석 · 빌드를 하지 않는다 */ skipped?: number }) {
  const { t } = useI18n();
  return <ol className="stage-chips" aria-label={t.run.chipsLabel}>
    {railStages.map((stage, index) => {
      const skip = index < skipped;
      const done = !skip && view.stage !== null && index < view.stage;
      const current = !skip && view.outcome === 'active' && view.stage === index;
      const state = skip ? 'skipped' : done ? 'done' : current ? 'current' : 'pending';
      // 실패·중단은 백엔드가 멈춘 단계를 주지 않는다(stage = null). 어디까지 갔는지 지어내지 않고 단계 이름만 보여 준다.
      const note = skip ? t.run.chipSkipped : view.stage === null ? null : done ? t.run.chipDone : current ? (view.waiting === 'approval' ? t.run.chipWaiting : view.waiting === 'queue' ? t.run.chipQueued : t.run.chipCurrent) : t.run.chipPending;
      return <li key={stage} className={`stage-chip is-${state}`} aria-current={current ? 'step' : undefined}>
        <GadgetIcon kind={stage} size={18} />
        <span>{t.stages[stage]}</span>
        {note && <span className="stage-chip__note">{done ? `✓ ${note}` : current && currentElapsed && !view.waiting ? `${note} ${currentElapsed}` : note}</span>}
      </li>;
    })}
  </ol>;
}

interface DeploymentProgressProps { deploymentId: string; /** 주소가 고른 탭 */ tab: DeploymentTab; onNavigate: Navigate; onSucceeded?: () => void; onNewDeployment?: () => void; /** 연결(AWS 키 등)을 고치러 연결 화면으로 간다 */ onFixSettings?: (projectId: string | null) => void; /** 재배포로 만든 새 배포의 진행 화면으로 간다 */ onRedeployed?: (deploymentId: string) => void }

export function DeploymentProgress({ deploymentId, tab, onNavigate, onSucceeded, onNewDeployment, onFixSettings, onRedeployed }: DeploymentProgressProps) {
  const { t } = useI18n();
  const [status, setStatus] = useState<DeploymentStatusResponse | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [recentLines, setRecentLines] = useState<string[]>([]);
  // 빌드 로그가 "이미지 재사용"을 알려 주면 그 원본 배포 번호 (재배포 · 롤백 · 환경 전환 장면에 쓴다)
  const [reusedFrom, setReusedFrom] = useState<string | null>(null);
  const [projectDeployments, setProjectDeployments] = useState<ProjectDeploymentSummary[] | null>(null);
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
      // 로그 한 줄마다 상태를 다시 조회하지 않는다. 작업 노트와 펼친 로그에만 붙인다.
      if (event.name === 'log.line') {
        const entry = readLogLine(event.payload);
        if (!entry) return;
        setRecentLines((previous) => [...previous, entry.line].slice(-RECENT_LINES));
        const reused = readReusedFrom(entry.line);
        if (reused) setReusedFrom(reused);
        setLogs((previous) => (previous ? appendLogLine(previous, entry) : previous));
        return;
      }
      void refresh();
    }, () => { /* The server closes SSE after succeeded/failed; HTTP remains authoritative. */ });
  }, [deploymentId, refresh]);

  // "지금" 줄 — 단계별 마지막 로그 몇 줄을 받아 가장 최근 것들을 쓴다. 실시간 줄이 먼저 왔으면 건드리지 않는다.
  useEffect(() => {
    let active = true;
    void Promise.allSettled(deploymentLogSteps.map((step) => getDeploymentLogs(deploymentId, step, RECENT_LINES))).then((results) => {
      if (!active) return;
      const lines = results.flatMap((result) => (result.status === 'fulfilled' && result.value ? result.value.trim().split('\n') : [])).filter(Boolean);
      const reused = lines.map(readReusedFrom).find((value) => value !== null);
      if (reused) setReusedFrom(reused);
      const newest = lines.sort((a, b) => lineTime(a) - lineTime(b)).slice(-RECENT_LINES);
      if (newest.length) setRecentLines((current) => (current.length ? current : newest));
    });
    return () => { active = false; };
  }, [deploymentId]);

  const projectId = text(status?.projectId);
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    getProject(projectId).then((project) => { if (active) setProjectName(project.name); }, () => { /* 이름은 없어도 진행 화면은 동작한다 */ });
    // 이 앱에서 지금까지 서비스하던 버전을 찾는 데 쓴다. 못 받으면 처음 배포처럼 그린다.
    listProjectDeployments(projectId, { limit: 50 }).then((page) => { if (active) setProjectDeployments(page.items); }, () => { /* 목록이 없어도 진행 화면은 동작한다 */ });
    return () => { active = false; };
  }, [projectId]);

  const currentStatus = deploymentStatus(status);

  // 원클릭: 승인 대기 상태가 되면 사용자 입력 없이 바로 승인한다 (대상 확인 → target, 배포 계획 → plan).
  // 다른 탭이나 서버가 먼저 승인했으면(APPROVAL_GATE_NOT_PENDING) 정상으로 본다. 실패하면 멈춘 채 다시 시도 버튼을 보여 준다.
  const pendingGate = currentStatus ? autoApprovalGates[currentStatus] ?? null : null;
  const [approvalError, setApprovalError] = useState<{ gate: ApprovalGate; cause: unknown } | null>(null);
  const approveGate = useCallback(async (gate: ApprovalGate) => {
    setApprovalError(null);
    try {
      await approveDeploymentGate(deploymentId, gate, AUTO_APPROVAL_NOTE);
    } catch (requestError) {
      if (!(requestError instanceof DeploymentApiError && requestError.code === 'APPROVAL_GATE_NOT_PENDING')) setApprovalError({ gate, cause: requestError });
    }
    await refresh();
  }, [deploymentId, refresh]);
  // 대상 승인 전에 멈춰서 사용자에게 받을 것이 있는지 본다 (#142, #144, #150).
  //  - 등록해야만 배포되는 환경변수가 있을 때 (서버의 missingEnvNames)
  //  - 분석이 포트를 찾지 못했을 때
  //  - 사용자가 간단 배포에서 "배포 전에 포트 확인하기"를 켰을 때
  // 어느 것도 아니면 지금까지처럼 바로 승인한다 (원클릭 유지). 확인하지 못해도 멈추지 않는다.
  const [review, setReview] = useState<PreDeployReview | null>(null);
  const autoApproved = useRef(new Set<ApprovalGate>());
  useEffect(() => {
    if (!pendingGate || autoApproved.current.has(pendingGate)) return;
    autoApproved.current.add(pendingGate);
    if (pendingGate !== 'target') { void approveGate(pendingGate); return; }
    // 이 확인은 배포당 한 번만 시작한다(위의 autoApproved). 효과가 다시 실행돼도 취소하지 않아야 승인이 빠지지 않는다.
    void Promise.all([
      getDeploymentAnalysisReport(deploymentId).then((report) => report.missingEnvNames ?? [], () => [] as string[]),
      getDeploymentIr(deploymentId).then((ir) => ({ ports: detectedPorts(ir.ir), version: typeof ir.version === 'number' ? ir.version : null }), () => ({ ports: [] as DetectedPort[], version: null })),
    ]).then(([envNames, ir]) => {
      const portMissing = ir.ports.some((item) => item.port === null);
      const showPorts = ir.version !== null && (portMissing || reviewRequested(deploymentId));
      if (envNames.length === 0 && !showPorts) { void approveGate('target'); return; }
      setReview({ envNames, ports: showPorts ? ir.ports : [], irVersion: ir.version });
    });
  }, [pendingGate, approveGate, deploymentId]);
  const waitingForEnv = review !== null && pendingGate === 'target';

  const statusView = deploymentStatusView(currentStatus ?? 'received');
  // 승인은 자동으로 넘어가므로 "확인 대기"로 보여 주지 않는다. 자동 승인이 실패했을 때만 대기로 보여 준다.
  const view = pendingGate && approvalError === null && !waitingForEnv ? { ...statusView, waiting: null } : statusView;

  // 진행 중 → 성공/실패로 바뀌는 순간에만 효과음. 성공이면 코로가 컵에 착지하는 걸 보여 준 뒤 결과 화면으로 넘어간다.
  // 이미 끝난 배포를 열었을 때는 넘어가지 않는다 (결과 화면의 "진행 화면" 버튼으로 돌아올 수 있어야 한다).
  const { play } = useSound();
  const onSucceededRef = useRef(onSucceeded);
  const playRef = useRef(play);
  useEffect(() => { onSucceededRef.current = onSucceeded; playRef.current = play; }, [onSucceeded, play]);
  const previousStatus = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = currentStatus;
    const transitioned = Boolean(previous) && previous !== currentStatus && previous !== 'succeeded' && previous !== 'failed';
    if (transitioned && currentStatus === 'failed') playRef.current('failure');
    if (currentStatus !== 'succeeded' || !transitioned) return;
    playRef.current('success');
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const timer = window.setTimeout(() => onSucceededRef.current?.(), reduced ? 0 : SUCCESS_LANDING_MS);
    return () => window.clearTimeout(timer);
  }, [currentStatus]);

  const now = useNow(view.outcome === 'active');
  const createdAt = text(status?.createdAt);
  const finishedAt = text(status?.succeededAt) ?? text(status?.failedAt);
  const elapsedText = createdAt ? elapsed(createdAt, finishedAt ? Date.parse(finishedAt) : now) : null;
  const title = view.outcome === 'active' ? t.run.titleActive : view.outcome === 'success' ? t.run.titleSucceeded : view.outcome === 'failed' ? t.run.titleFailed : t.run.titleStopped;
  // 서버가 준 현재 단계의 시작 시각. 단계 칩에 "그 단계에서 흐른 시간"을 보여 주는 데 쓴다(없으면 표시하지 않는다).
  const currentStep = status?.currentStep && typeof status.currentStep === 'object' ? status.currentStep as { startedAt?: unknown } : null;
  const stepStartedAt = text(currentStep?.startedAt);
  // 코로의 말과 몸짓에 쓰는 "이 단계에서 흐른 시간". 서버가 준 단계 시작 시각과, 이 화면이 본 마지막 상태 변화 중 늦은 쪽부터 센다.
  // (서버는 인프라 준비와 배포를 한 단계로 기록하므로, 상태가 바뀐 순간을 화면에서도 기억한다.)
  const [changedAt, setChangedAt] = useState<{ status: string; at: number } | null>(null);
  useEffect(() => {
    if (!currentStatus) return;
    setChangedAt((previous) => (previous === null ? { status: currentStatus, at: 0 } : previous.status === currentStatus ? previous : { status: currentStatus, at: Date.now() }));
  }, [currentStatus]);
  const stageSince = Math.max(stepStartedAt ? Date.parse(stepStartedAt) : 0, changedAt?.at ?? 0);
  const stepSeconds = stageSince > 0 ? Math.max(0, Math.floor((now - stageSince) / 1000)) : 0;
  const rolling = view.outcome === 'active' && !view.waiting && !waitingForEnv;
  // 분석이 끝난 뒤(빌드 단계부터) 분석 결과를 받아 코로가 말할 사실로 쓴다. 못 받아도 일반 문장으로 말한다.
  const [facts, setFacts] = useState<AnalysisFacts | null>(null);
  const analysisDone = view.stage !== null && view.stage >= 1;
  useEffect(() => {
    if (!analysisDone) return;
    let active = true;
    getDeploymentAnalysisReport(deploymentId).then((report) => { if (active) setFacts(readAnalysisFacts(report.services)); }, () => { /* 분석 결과가 없어도 진행 화면은 동작한다 */ });
    return () => { active = false; };
  }, [deploymentId, analysisDone]);
  const target = sceneTarget(text(status?.targetProfile));
  const story = projectDeployments ? deployStory(deploymentId, target, previousLive(deploymentId, projectDeployments), reusedFrom) : null;
  const talk = rolling && view.stage !== null ? koroLine(view.stage, stepSeconds, facts, target, t, story) : null;
  // 장면에 쓰는 단계: AWS는 인프라 준비 도중에 비행 장면으로 넘어간다(서버의 "배포" 상태가 순식간이라서). 코로의 말은 실제 단계를 따른다.
  const sceneView = awsSceneStage(view, target, stepSeconds);
  // 장면이 보여 주는 범위. 이미지를 재사용하는 배포는 설계도와 집 짓는 곳을 잘라 내서 가로가 좁다(같은 축척으로 가운데에 둔다).
  const box = sceneBox(target, story);
  const [koroX, koroY] = koroSpot(sceneView, target, story);
  // 장면 효과음: 코로가 새 일을 시작할 때 한 번. 화면을 처음 열었을 때는 내지 않는다(이미 진행 중이던 단계).
  // 빌드 단계는 "이미지 재사용" 로그가 바로 뒤따라올 수 있어서, 잠깐 기다렸다가 그때의 장면에 맞는 소리를 낸다.
  const cue = rolling ? sceneCue(sceneView.stage, target, story) : null;
  const cueSeen = useRef(false);
  useEffect(() => {
    if (!cueSeen.current) { cueSeen.current = true; return; }
    if (!cue) return;
    const timer = window.setTimeout(() => playRef.current(cue), 450);
    return () => window.clearTimeout(timer);
  }, [cue]);
  // 빌드 중 집의 층이 올라갈 때마다 (장면의 층수 계산과 같은 박자: 8초마다, 3층까지)
  const risingFloor = rolling && view.stage === 1 && !story?.reused ? Math.min(houseFloors(story) - 1, Math.floor(stepSeconds / 8)) : 0;
  useEffect(() => { if (risingFloor > 0) playRef.current('floor'); }, [risingFloor]);
  const failureMessage = text(status?.error);
  // 서버가 준 실패 코드를 아는 경우에만 안내 문구로 바꾼다. 코드 자체도 함께 보여 준다.
  const failure = failureKind(failureMessage);
  // 코드와 상세(서버가 붙여 준 오류 원문)를 나눠서, 코드는 한 줄로 · 상세는 접어서 보여 준다.
  const failureParts = parseFailure(failureMessage);
  const publicUrl = safeHttpUrl(text(status?.publicUrl));

  async function loadLogs() {
    const results = await Promise.allSettled(deploymentLogSteps.map(async (step) => ({ step, text: await getDeploymentLogs(deploymentId, step) })));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure && results.every((result) => result.status === 'rejected')) {
      setError({ cause: failure.reason, fallback: 'logsFailed' });
      return;
    }
    setLogs(results.flatMap((result) => (result.status === 'fulfilled' && result.value.text !== null ? [{ step: result.value.step, text: result.value.text }] : [])));
  }


  // 로그 탭을 처음 열 때 전체 로그를 읽는다. 그 뒤로는 실시간 이벤트가 줄을 덧붙인다.
  const logsWanted = tab === 'logs' && logs === null && !loading && status !== null;
  useEffect(() => { if (logsWanted) void loadLogs(); });

  if (loading) return <section className="panel"><h2>{t.progress.heading}</h2><p>{t.progress.checking}</p></section>;
  // 상태를 한 번도 받지 못했으면(없는 배포 · 서버 오류) 진행 중인 것처럼 그리지 않는다.
  if (!status) return <section className="panel">
    <h2>{t.progress.heading}</h2>
    {error && <div className="notice error" role="alert"><strong>{t.progress.statusError}</strong><br />{errorMessage(error.cause, t, t.errors[error.fallback])}</div>}
    <div className="page-actions">
      <Keycap variant="secondary" onClick={() => void refresh()}>{t.progress.refresh}</Keycap>
      {onNewDeployment && <Keycap variant="ghost" onClick={onNewDeployment}>{t.run.newDeploy}</Keycap>}
    </div>
  </section>;

  // 탭: 주소에 탭이 없으면 실패한 배포는 실패 원인, 그 밖은 진행을 보여 준다. 실패 원인 탭은 실패했을 때만 있다.
  const failed = view.outcome === 'failed';
  const shownTab: Exclude<DeploymentTab, 'auto'> = tab === 'auto' || (tab === 'failure' && !failed) ? (failed ? 'failure' : 'progress') : tab;
  const base = `/deployments/${encodeURIComponent(deploymentId)}`;
  const tabs: Array<{ tab: Exclude<DeploymentTab, 'auto'>; label: string }> = [
    { tab: 'progress', label: t.run.tabs.progress },
    ...(failed ? [{ tab: 'failure' as const, label: t.run.tabs.failure }] : []),
    { tab: 'logs', label: t.run.tabs.logs },
    { tab: 'analysis', label: t.run.tabs.analysis },
  ];
  // 진행 탭에 사용자가 해야 할 일이 있는데 다른 탭을 보고 있으면 탭에 점으로 알린다.
  const needsAttention = waitingForEnv || approvalError !== null;

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
          {view.outcome === 'active' && approvalError === null && <span>{waitingForEnv ? t.run.review.waiting : currentStepLabel(currentStatus, t)}</span>}
          <span className="run-head__id">{projectName ? `${displayProjectName(projectName)} · ` : ''}{t.dashboard.deploymentNo(deploymentId)}</span>
        </p>
      </div>

      <StageChips view={view} skipped={story?.reused ? 2 : 0} currentElapsed={stepStartedAt && view.outcome === 'active' ? elapsed(stepStartedAt, now) : null} />

      {error && <div className="notice error" role="alert"><strong>{t.progress.statusError}</strong><br />{errorMessage(error.cause, t, t.errors[error.fallback])}</div>}

      <nav className="tabs run-tabs" aria-label={t.run.tabsLabel}>
        {tabs.map((item) => <a key={item.tab} href={`${base}/${item.tab}`} className="tabs__tab" aria-current={item.tab === shownTab ? 'page' : undefined}
          onClick={(event) => followAppLink(event, onNavigate)}>
          {item.label}
          {item.tab === 'progress' && needsAttention && shownTab !== 'progress' && <><span className="tabs__dot" aria-hidden="true" /><span className="visually-hidden"> {t.run.tabs.attention}</span></>}
        </a>)}
      </nav>

      {shownTab === 'progress' && <>
        {waitingForEnv && projectId && review && <PreDeployPanel deploymentId={deploymentId} projectId={projectId} review={review}
          onDone={() => { setReview(null); clearReview(deploymentId); void approveGate('target'); }} />}

        {approvalError !== null && <div className="notice error run-failure" role="alert">
          <strong>{t.run.approveFailed}</strong>
          <p>{approvalError.cause instanceof DeploymentApiError && approvalError.cause.code === 'DEPLOYMENT_LOCKED' ? t.run.approveLocked : errorMessage(approvalError.cause, t, t.run.approveFailed)}</p>
          <Keycap variant="secondary" onClick={() => void approveGate(approvalError.gate)}>{t.run.approveRetry}</Keycap>
        </div>}

        <figure className={`run-scene ${talk ? 'has-talk' : ''}`} style={box.left > 0 ? { maxWidth: `${Math.round((box.width / SCENE_SIZE.width) * 1100)}px` } : undefined}>
          <DeployScene view={sceneView} target={target} idle={rolling ? koroIdle(stepSeconds) : null} stepSeconds={stepSeconds} story={story} />
          {/* 코로의 생각 풍선: 지금 단계에서 무슨 일이 일어나는지 쉬운 말로. 코로 머리에 붙어서 같이 움직인다(작은 방울 두 개로 이어진다).
              풍선은 코로의 오른쪽 위에 둔다. 장면 오른쪽 끝(검증 장치)에서만 카드 밖으로 나가지 않게 왼쪽 위로 펼친다.
              좁은 화면에서는 배포 장치(is-near-edge)에서도 왼쪽으로 펼친다. */}
          {talk && <div className={`koro-think ${koroX - box.left > box.width * 0.85 ? 'is-left' : 'is-right'} ${koroX - box.left > box.width * 0.7 ? 'is-near-edge' : ''}`}
            style={{ '--koro-x': `${((koroX - box.left) / box.width) * 100}%`, '--koro-y': `${((koroY - SCENE_SIZE.koro / 2 - 10 - box.top) / box.height) * 100}%` } as CSSProperties}>
            <span className="koro-think__dot" aria-hidden="true" /><span className="koro-think__dot" aria-hidden="true" />
            <p key={talk} className="koro-think__bubble">{talk}</p>
          </div>}
        </figure>

        <HealthProgress deploymentId={deploymentId} status={currentStatus} />

        {view.outcome === 'active' && <CancelDeployment deploymentId={deploymentId} onCancelled={() => void refresh()} />}

        {failed && <a className="setup-summary__link" href={`${base}/failure`} onClick={(event) => followAppLink(event, onNavigate)}>{t.run.viewFailure}</a>}

        {view.outcome === 'success' && <div className="run-success">
          {publicUrl && <a className="run-success__url" href={publicUrl} target="_blank" rel="noreferrer">{hostOf(publicUrl)}<span className="visually-hidden"> {t.dashboard.newTab}</span></a>}
          {publicUrl && <Keycap href={publicUrl} target="_blank" rel="noreferrer">{t.progress.openApp}</Keycap>}
          {onSucceeded && <Keycap variant="secondary" onClick={onSucceeded}>{t.run.viewResult}</Keycap>}
        </div>}
      </>}

      {shownTab === 'failure' && <div className="notice error run-failure" role="alert">
        <strong>{t.run.failedCause}</strong>
        {/* 분류하지 못한 코드도 코드만 덩그러니 보이지 않게, 일반 안내 문구 아래에 작게 둔다. */}
        <p>{failure ? (failureParts.detail ? t.run.failureReasonsWithDetail[failure] : undefined) ?? t.run.failureReasons[failure] : failureMessage ? t.run.failureUnknown : t.progress.failedCopy}</p>
        {failureParts.code && <p className="run-failure__code">{t.run.failureCode(failureParts.code)}</p>}
        {failureParts.detail && <FailureDetail detail={failureParts.detail} />}
        <FailureDiagnosis deploymentId={deploymentId} />
        <div className="run-failure__actions">
          {fixableByAwsKey(failure) && onFixSettings && <Keycap onClick={() => onFixSettings(projectId)}>{t.run.fixAwsKey}</Keycap>}
          {/* 실패한 배포는 같은 소스로 다시 배포한다. ZIP을 다시 올리는 길은 재배포를 시작하지 못했을 때만 보여 준다. */}
          {onRedeployed && <RedeployButton variant={fixableByAwsKey(failure) ? 'secondary' : 'primary'} deploymentId={deploymentId} onStarted={onRedeployed} onUploadAgain={onNewDeployment} />}
        </div>
      </div>}
    </section>

    {shownTab === 'logs' && <section className="work-note" aria-label={t.run.workNote}>
      <div className="work-note__bar">
        <h2>{t.run.workNote}</h2>
        <p className="work-note__line">{recentLines[recentLines.length - 1] ?? t.run.noNote}</p>
        <div className="work-note__actions">
          <Keycap variant="ghost" onClick={() => { void refresh(); void loadLogs(); }}>{t.progress.refresh}</Keycap>
        </div>
      </div>
      <div className="work-note__logs">
        {logs === null ? <p>{t.progress.stepLoading}</p>
          : logs.length ? logs.map((entry) => <div key={entry.step} className="step-log"><strong>{t.progress.logSteps[entry.step]}</strong><pre>{entry.text}</pre></div>)
            : <p>{t.progress.noLogs}</p>}
      </div>
    </section>}

    {shownTab === 'analysis' && <DeploymentAnalysis deploymentId={deploymentId} deploymentStatus={currentStatus} />}
  </>;
}
