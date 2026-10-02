import type { CSSProperties } from 'react';
import { Koro, type KoroMood } from '../../components/ui/Koro';
import { useI18n } from '../../i18n/I18nProvider';
import { railStageCount, railStages, type DeploymentStatusView } from '../deployment-status/status-view';

/**
 * 연쇄장치 장면. 코로의 위치는 백엔드 status에서 나온 단계(view.stage)로만 정한다.
 * 단계 사이를 추정해서 움직이지 않는다 — 상태가 바뀔 때만 다음 장치로 굴러간다.
 * 장치: 출발대(ZIP) → 도미노(분석) → 깔때기(빌드) → 나선(인프라 준비) → 도약대(배포) → 저울(검증) → 도착점(완료).
 * 도착점은 배포할 곳을 그린다 — AWS는 구름, 온프레미스는 서버. 모르면 컵.
 * 시간이 걸리는 빌드 · 인프라 준비 · 배포를 장치 하나씩으로 나눠서, 코로가 긴 구간에서도 자리를 옮긴다.
 */

const KORO_SIZE = 56;

/** 단계별 코로 중심 좌표 (0 도미노 · 1 깔때기 · 2 나선 · 3 도약대 · 4 저울 · 5 컵) */
const koroSpots: ReadonlyArray<readonly [number, number]> = [[330, 160], [530, 170], [700, 300], [910, 366], [1060, 352], [1155, 414]];
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

export type SceneTarget = 'aws' | 'onprem' | null;

/** targetProfile(aws-ecs-basic · onprem-docker-basic)에서 도착점 그림을 고른다. */
export function sceneTarget(profile: string | null): SceneTarget {
  if (profile?.startsWith('aws')) return 'aws';
  if (profile?.startsWith('onprem')) return 'onprem';
  return null;
}

export function DeployScene({ view, target = null }: { view: DeploymentStatusView; target?: SceneTarget }) {
  const { t } = useI18n();
  const analyze = gadgetState(0, view);
  const build = gadgetState(1, view);
  const provision = gadgetState(2, view);
  const deploy = gadgetState(3, view);
  const verify = gadgetState(4, view);
  // 출발대는 단계가 아니다(업로드는 배포를 만들 때 이미 끝났다). 배포가 있으면 지나온 곳으로 그린다.
  const launched = view.stage !== null;

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
  const launchRail = launched ? 'scene-rail is-done' : 'scene-rail';
  // 일하는 중인 장치는 계속 움직인다(진행률이 아니라 "지금 여기서 일하고 있다"는 표시). 대기 중에는 멈춘다.
  const working = (state: GadgetState) => (state === 'current' && rolling ? 'is-working' : '');

  return <svg className={`deploy-scene is-${view.outcome}`} viewBox="0 0 1200 500" role="img" aria-label={label}>
    <line className="scene-floor" x1="20" y1="488" x2="1180" y2="488" />
    {[[95, 142], [330, 226], [530, 302], [700, 396], [910, 412]].map(([x, y]) => <line key={x} className="scene-post" x1={x} y1={y} x2={x} y2="488" />)}

    {/* 출발대 (ZIP) */}
    <g className={`scene-gadget is-${launched ? 'done' : 'pending'}`}>
      <rect className="scene-ink-deep" x="40" y="104" width="110" height="44" rx="12" />
      <rect className="scene-ink" x="40" y="96" width="110" height="44" rx="12" />
      <ellipse className="scene-ink-deep" cx="95" cy="116" rx="20" ry="8" />
      <rect className="scene-paper" x="72" y="62" width="46" height="28" rx="3" />
      <path className="scene-stroke" d="M72 72 H118" />
      <text className="scene-zip" x="95" y="84" textAnchor="middle">ZIP</text>
    </g>

    <path className={launchRail} d="M150 134 L232 218" />

    {/* 0 · 도미노 — 분석 */}
    <path className={launchRail} d="M232 222 L440 222" />
    <g className={`scene-gadget is-${analyze}`}>
      {/* 분석이 끝나면 도미노가 쓰러진다 (CSS transform이라 전환이 애니메이션된다) */}
      {[250, 290, 330, 370, 410].map((x, index) => <rect key={x} className="scene-paper scene-domino" x="0" y="-48" width="13" height="48" rx="3"
        style={{ transform: `translate(${x}px, 218px) rotate(${analyze === 'done' ? (index === 4 ? 76 : 70) : 0}deg)`, transitionDelay: `${index * 60}ms` }} />)}
    </g>
    <Label x={330} y={240} width={100} text="ANALYZE" state={analyze} />

    <path className={railClass(0, view)} d="M440 222 Q458 214 472 198" />

    {/* 1 · 깔때기 — 빌드 */}
    <g className={`scene-gadget scene-funnel is-${build} ${working(build)}`}>
      <path className="scene-funnel-body" d="M456 190 H604 L550 262 V300 H510 V262 Z" />
      <path className="scene-line scene-funnel__level" d="M480 204 H582" />
      <path className="scene-line scene-funnel__level" d="M500 222 H562" />
    </g>
    <Label x={530} y={148} width={80} text="BUILD" state={build} />

    <path className={railClass(1, view)} d="M530 302 L608 336" />

    {/* 2 · 나선 — 인프라 준비 */}
    <g className={`scene-spiral is-${provision} ${working(provision)}`}>
      <ellipse cx="700" cy="330" rx="100" ry="64" />
      <ellipse cx="700" cy="334" rx="66" ry="42" />
      <ellipse cx="700" cy="338" rx="32" ry="20" />
    </g>
    <Label x={700} y={404} width={112} text="PROVISION" state={provision} />

    <path className={railClass(2, view)} d="M798 346 L862 392" />

    {/* 3 · 도약대 — 배포 */}
    <g className={`scene-gadget scene-springboard is-${deploy} ${working(deploy)}`}>
      <line x1="872" y1="404" x2="872" y2="436" />
      <line x1="948" y1="404" x2="948" y2="436" />
      <line x1="858" y1="436" x2="962" y2="436" />
      <path className="scene-springboard__bed" d="M862 396 Q910 418 958 396" />
    </g>
    <Label x={910} y={446} width={88} text="DEPLOY" state={deploy} />

    <path className={railClass(3, view)} d="M958 396 L1016 390" />

    {/* 4 · 저울 — 검증 */}
    <g className={`scene-gadget scene-scale is-${verify} ${working(verify)}`}>
      <line x1="1060" y1="384" x2="1060" y2="472" />
      <line x1="1036" y1="472" x2="1084" y2="472" />
      <line x1="1016" y1="392" x2="1104" y2="392" />
      <path d="M1016 392 L1006 414 H1030 Z" />
      <path d="M1104 392 L1094 414 H1118 Z" />
    </g>
    <Label x={1060} y={428} width={88} text="VERIFY" state={verify} />

    <path className={`${railClass(4, view)} scene-rail--last`} d="M1104 414 L1138 440" />

    {/* 5 · 도착점 — 배포할 곳 (AWS 구름 · 온프레미스 서버 · 모르면 컵) */}
    <g className={`scene-cup ${view.outcome === 'success' ? 'is-done' : ''}`}>
      {target === 'aws' && <path d="M1136 474 H1176 A13 13 0 0 0 1178 448 A17 17 0 0 0 1146 444 A15 15 0 0 0 1136 474 Z" />}
      {target === 'onprem' && <>
        <path d="M1128 442 H1182 V456 H1128 Z" />
        <path d="M1128 460 H1182 V474 H1128 Z" />
        <path className="scene-cup__detail" d="M1136 449 H1140 M1136 467 H1140 M1150 449 H1174 M1150 467 H1174" />
      </>}
      {target === null && <path d="M1128 444 H1182 V456 A27 24 0 0 1 1128 456 Z" />}
      {target === null && view.outcome === 'success' && <circle cx="1155" cy="452" r="8" />}
    </g>

    <g className="scene-koro" style={koroPosition}>
      <g className={rolling ? 'scene-koro__bob' : undefined}>
        <Koro mood={mood} size={KORO_SIZE} />
      </g>
    </g>
  </svg>;
}
