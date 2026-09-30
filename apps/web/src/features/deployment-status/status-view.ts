import type { MarbleTone } from '../../components/ui/Marble';

/**
 * 백엔드 배포 상태(apps/worker/src/state-machine.ts STATUSES) → 화면 표현.
 * 화면 단계: 0 소스 업로드 · 1 AI 분석 · 2 배포 · 3 검증 · 4 완료(컵).
 * 실패·취소·거절은 목록 API가 멈춘 단계를 주지 않으므로 stage = null.
 * 문구는 i18n 사전(status.stage[stageKey], stages[railStages[i]])에서 고른다.
 */
export type DeploymentOutcome = 'active' | 'success' | 'failed' | 'stopped' | 'unknown';
export type StageKey = 'source' | 'analyze' | 'deploy' | 'verify' | 'rollback' | 'arrived' | 'failed' | 'cancelled' | 'rejected' | 'unknown';

export interface DeploymentStatusView {
  tone: MarbleTone;
  tape: string;
  stage: number | null;
  stageKey: StageKey;
  outcome: DeploymentOutcome;
  /** 사람(또는 자동) 승인을 기다리는 상태 — awaiting_* */
  waiting: boolean;
}

export const railStages = ['source', 'analyze', 'deploy', 'verify'] as const;
export const railStageCount = railStages.length;

const activeStages: Record<string, number> = {
  received: 0,
  analyzing: 1, awaiting_patch_approval: 1, awaiting_target_confirmation: 1,
  queued: 2, building: 2, planning: 2, awaiting_plan_approval: 2, provisioning: 2, deploying: 2,
  verifying: 3, rollback: 3,
};

export function deploymentStatusView(status: string): DeploymentStatusView {
  if (status in activeStages) {
    const stage = activeStages[status];
    return { tone: 'running', tape: 'DEPLOYING', stage, stageKey: status === 'rollback' ? 'rollback' : railStages[stage], outcome: 'active', waiting: status.startsWith('awaiting_') };
  }
  switch (status) {
    case 'succeeded': return { tone: 'success', tape: 'LIVE', stage: railStageCount, stageKey: 'arrived', outcome: 'success', waiting: false };
    case 'failed': return { tone: 'failed', tape: 'FAILED', stage: null, stageKey: 'failed', outcome: 'failed', waiting: false };
    case 'cancelled': return { tone: 'waiting', tape: 'CANCELLED', stage: null, stageKey: 'cancelled', outcome: 'stopped', waiting: false };
    case 'rejected': return { tone: 'waiting', tape: 'REJECTED', stage: null, stageKey: 'rejected', outcome: 'stopped', waiting: false };
    default: return { tone: 'waiting', tape: status.toUpperCase(), stage: null, stageKey: 'unknown', outcome: 'unknown', waiting: false };
  }
}
