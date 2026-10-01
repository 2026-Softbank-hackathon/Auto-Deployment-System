import type { CSSProperties } from 'react';
import { Koro, type KoroMood } from '../../components/ui/Koro';
import { useI18n } from '../../i18n/I18nProvider';
import { railStageCount, railStages, type DeploymentStatusView } from '../deployment-status/status-view';

/**
 * 시안 04 연쇄장치 장면. 코로의 위치는 백엔드 status에서 나온 단계(view.stage)로만 정한다.
 * 단계 사이를 추정해서 움직이지 않는다 — 상태가 바뀔 때만 다음 장치로 굴러간다.
 */

const KORO_SIZE = 56;

/** 단계별 코로 중심 좌표 (0 출발대 · 1 도미노 · 2 깔때기 지난 나선 · 3 저울 · 4 컵) */
const koroSpots: ReadonlyArray<readonly [number, number]> = [[95, 34], [490, 160], [860, 240], [1060, 352], [1155, 414]];
const FALLEN_SPOT: readonly [number, number] = [600, 456];

type GadgetState = 'done' | 'current' | 'pending';

function gadgetState(index: number, view: DeploymentStatusView): GadgetState {
  if (view.stage === null) return 'pending';
  if (index < view.stage) return 'done';
  return index === view.stage && view.outcome === 'active' ? 'current' : 'pending';
}

function railClass(index: number, view: DeploymentStatusView): string {
  return view.stage !== null && view.stage > index ? 'scene-rail is-done' : 'scene-rail';
}

function Label({ x, y, width, text, state }: { x: number; y: number; width: number; text: string; state: GadgetState }) {
  return <g className={`scene-label is-${state}`}>
    <rect x={x - width / 2} y={y} width={width} height="22" rx="3" />
    <text x={x} y={y + 15} textAnchor="middle">{state === 'done' ? `${text} ✓` : text}</text>
  </g>;
}

export function DeployScene({ view }: { view: DeploymentStatusView }) {
  const { t } = useI18n();
  const upload = gadgetState(0, view);
  const analyze = gadgetState(1, view);
  const deploy = gadgetState(2, view);
  const verify = gadgetState(3, view);

  const fallen = view.outcome === 'failed';
  const [cx, cy] = fallen ? FALLEN_SPOT : koroSpots[Math.min(view.stage ?? 0, railStageCount)];
  const mood: KoroMood = fallen ? 'flustered' : view.outcome === 'success' ? 'happy' : view.waiting || view.outcome !== 'active' ? 'sleepy' : 'normal';
  const rolling = view.outcome === 'active' && !view.waiting;
  const stageName = view.stage !== null && view.stage < railStageCount ? t.stages[railStages[view.stage]] : '';
  const label = fallen ? t.run.sceneFailed
    : view.outcome === 'success' ? t.run.sceneSucceeded
      : view.outcome !== 'active' ? t.run.sceneStopped
        : view.waiting === 'approval' ? t.run.sceneWaiting(stageName) : view.waiting === 'queue' ? t.run.sceneQueued(stageName) : t.run.sceneActive(stageName);

  const koroPosition = { transform: `translate(${cx - KORO_SIZE / 2}px, ${cy - KORO_SIZE / 2}px)` } as CSSProperties;

  return <svg className={`deploy-scene is-${view.outcome}`} viewBox="0 0 1200 500" role="img" aria-label={label}>
    <line className="scene-floor" x1="20" y1="488" x2="1180" y2="488" />
    {[[95, 142], [265, 172], [490, 226], [690, 302], [860, 396]].map(([x, y]) => <line key={x} className="scene-post" x1={x} y1={y} x2={x} y2="488" />)}

    {/* 0 · 출발대 */}
    <g className={`scene-gadget is-${upload}`}>
      <rect className="scene-ink-deep" x="40" y="104" width="110" height="44" rx="12" />
      <rect className="scene-ink" x="40" y="96" width="110" height="44" rx="12" />
      <ellipse className="scene-ink-deep" cx="95" cy="116" rx="20" ry="8" />
      <rect className="scene-paper" x="72" y="62" width="46" height="28" rx="3" />
      <path className="scene-stroke" d="M72 72 H118" />
      <text className="scene-zip" x="95" y="84" textAnchor="middle">ZIP</text>
    </g>
    <Label x={95} y={162} width={88} text="UPLOAD" state={upload} />

    <path className={railClass(0, view)} d="M150 134 L380 218" />

    {/* 1 · 도미노 */}
    <path className={railClass(0, view)} d="M380 222 L600 222" />
    <g className={`scene-gadget is-${analyze}`}>
      {/* 분석이 끝나면 도미노가 쓰러진다 (CSS transform이라 전환이 애니메이션된다) */}
      {[402, 444, 486, 528, 570].map((x, index) => <rect key={x} className="scene-paper scene-domino" x="0" y="-48" width="13" height="48" rx="3"
        style={{ transform: `translate(${x}px, 218px) rotate(${analyze === 'done' ? (index === 4 ? 76 : 70) : 0}deg)`, transitionDelay: `${index * 60}ms` }} />)}
    </g>
    <Label x={490} y={240} width={100} text="ANALYZE" state={analyze} />

    <path className={railClass(1, view)} d="M600 222 Q618 214 632 198" />

    {/* 2 · 깔때기 */}
    <g className={`scene-gadget scene-funnel is-${deploy}`}>
      <path className="scene-funnel-body" d="M616 190 H764 L710 262 V300 H670 V262 Z" />
      <path className="scene-line" d="M640 204 H742" />
      <path className="scene-line" d="M660 222 H722" />
    </g>
    <Label x={690} y={148} width={92} text="DEPLOY" state={deploy} />

    <path className={railClass(2, view)} d="M690 302 L768 336" />
    <g className={railClass(2, view)}>
      <ellipse cx="860" cy="330" rx="100" ry="64" />
      <ellipse cx="860" cy="334" rx="66" ry="42" />
      <ellipse cx="860" cy="338" rx="32" ry="20" />
    </g>
    <path className={railClass(2, view)} d="M958 346 L1016 384" />

    {/* 3 · 저울 */}
    <g className={`scene-gadget scene-scale is-${verify}`}>
      <line x1="1060" y1="384" x2="1060" y2="472" />
      <line x1="1036" y1="472" x2="1084" y2="472" />
      <line x1="1016" y1="392" x2="1104" y2="392" />
      <path d="M1016 392 L1006 414 H1030 Z" />
      <path d="M1104 392 L1094 414 H1118 Z" />
    </g>
    <Label x={1060} y={428} width={88} text="VERIFY" state={verify} />

    <path className={`${railClass(3, view)} scene-rail--last`} d="M1104 414 L1138 440" />

    {/* 4 · 컵 */}
    <g className={`scene-cup ${view.outcome === 'success' ? 'is-done' : ''}`}>
      <path d="M1128 444 H1182 V456 A27 24 0 0 1 1128 456 Z" />
      {view.outcome === 'success' && <circle cx="1155" cy="452" r="8" />}
    </g>

    <g className="scene-koro" style={koroPosition}>
      <g className={rolling ? 'scene-koro__bob' : undefined}>
        <Koro mood={mood} size={KORO_SIZE} />
      </g>
    </g>
  </svg>;
}
