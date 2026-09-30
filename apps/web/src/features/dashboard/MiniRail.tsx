import type { CSSProperties } from 'react';
import { Marble } from '../../components/ui/Marble';
import { Rail, RailStop } from '../../components/ui/Rail';
import { useI18n } from '../../i18n/I18nProvider';
import type { Messages } from '../../i18n/ko';
import { railStageCount, railStages, type DeploymentStatusView } from '../deployment-status/status-view';

function describe(view: DeploymentStatusView, t: Messages): string {
  if (view.outcome === 'active' && view.stage !== null) return t.dashboard.railActive(railStageCount, view.stage + 1, t.stages[railStages[view.stage]]);
  if (view.outcome === 'success') return t.dashboard.railDone(railStageCount);
  if (view.outcome === 'failed') return t.dashboard.railFailed;
  return t.status.stage[view.stageKey];
}

/** 배포 1건의 위치. 구슬은 백엔드 상태에 해당하는 정거장 위에만 선다 (구간 사이 추정 위치 없음). */
export function MiniRail({ view }: { view: DeploymentStatusView }) {
  const { t } = useI18n();
  const reached = view.stage ?? -1;
  const progress = view.stage === null ? 0 : view.stage / railStageCount;
  const at = (index: number) => ({ '--stop': index / railStageCount } as CSSProperties);

  return <div className={`mini-rail mini-rail--${view.outcome}`} role="img" aria-label={describe(view, t)}>
    <Rail progress={progress} className="mini-rail__rail">
      {railStages.map((stage, index) => <RailStop key={stage} className="mini-rail__stop" style={at(index)}
        state={index <= reached ? 'done' : 'pending'} />)}
      {view.outcome === 'active' && view.stage !== null && <span className="mini-rail__marble" style={at(view.stage)}><Marble tone="running" /></span>}
    </Rail>
    <svg className="mini-rail__cup" width="30" height="28" viewBox="0 0 30 28" aria-hidden="true">
      <path d="M3 9 H27 V14 A12 11 0 0 1 3 14 Z" />
      {view.outcome === 'success' && <circle className="mini-rail__cup-marble" cx="15" cy="11" r="5.5" />}
    </svg>
    {view.outcome === 'failed' && <span className="mini-rail__fallen"><Marble tone="failed" size={14} /></span>}
  </div>;
}
