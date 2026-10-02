import type { CSSProperties } from 'react';
import { Koro, type KoroMood } from '../../components/ui/Koro';
import { useI18n } from '../../i18n/I18nProvider';
import { railStageCount, railStages, type DeploymentStatusView } from '../deployment-status/status-view';
import type { DeployStory } from './deploy-story';
import { KoroHat, KoroProp } from './KoroProp';

/**
 * 배포 여정 장면. 코로가 앱을 "집"으로 지어서 배포할 곳까지 옮긴다.
 *   0 분석      — 설계도(IR)를 살펴본다
 *   1 빌드      — 집(컨테이너 이미지)을 짓는다. 층이 올라간다
 *   2 인프라 준비 — AWS: 구름 위 자리를 만들고 비행기를 조립한다 · 온프레미스: 서버 옆 자리를 만들고 수레를 조립한다
 *   3 배포      — AWS: 집을 비행기에 싣고 구름으로 날아간다 · 온프레미스: 수레에 실어 서버 옆으로 민다
 *   4 검증      — 도착한 집에 불이 들어오는지 점검한다
 *   5 완료      — 집에 깃발이 오른다
 * 같은 집이 배포할 곳에 따라 다른 길로 간다(같은 이미지, 다른 환경).
 *
 * 재배포 · 롤백 · 환경 전환 (story):
 *   - 지금까지 서비스하던 버전은 도착점 옆자리에 작은 집으로 서 있고, LIVE 표지가 그 위에 있다.
 *     이 배포가 성공하면 표지가 새 집으로 옮겨 가고 옛 집은 불이 꺼진다.
 *   - 환경 전환이면 두 도착점(구름 · 서버 옆)을 함께 그린다.
 *   - 전에 만든 이미지를 재사용하면 집을 짓지 않고 창고(이미지 저장소)에서 꺼낸다.
 *   - 집마다 이미지 이름표(그 이미지를 만든 배포 번호)가 붙는다. 같은 이름표 = 같은 이미지.
 * 코로와 집의 위치는 백엔드 status에서 나온 단계(view.stage)로만 정한다. 단계 사이를 추정해서 움직이지 않는다.
 */

const KORO_SIZE = 72;
const GROUND = 440;
const KORO_Y = GROUND - KORO_SIZE / 2;

export type SceneTarget = 'aws' | 'onprem' | null;

/** targetProfile(aws-ecs-basic · onprem-docker-basic)에서 여정을 고른다. 모르는 값은 구름 쪽 그림을 쓴다(이름표 없이). */
export function sceneTarget(profile: string | null): SceneTarget {
  if (profile?.startsWith('aws')) return 'aws';
  if (profile?.startsWith('onprem')) return 'onprem';
  return null;
}

type Spot = readonly [number, number];
/** 비행기의 바닥 중심 좌표: 조립하는 곳(땅) → 날아가는 중(하늘). 집과 코로는 비행기 등(PLANE_TOP 높이)에 탄다 */
const PLANE_GROUND: Spot = [800, GROUND];
const PLANE_AIR: Spot = [900, 340];
const PLANE_TOP = 64;
/** 단계별 코로 중심 좌표 (0 설계도 · 1 집 짓는 곳 · 2 탈것 준비 · 3 이동 중 · 4 도착 · 5 완료) */
const skySpots: readonly Spot[] = [[285, KORO_Y], [415, KORO_Y], [640, KORO_Y], [PLANE_AIR[0] + 55, PLANE_AIR[1] - PLANE_TOP - KORO_SIZE / 2], [950, 114], [950, 114]];
const groundSpots: readonly Spot[] = [[285, KORO_Y], [415, KORO_Y], [640, KORO_Y], [780, KORO_Y], [925, KORO_Y], [925, KORO_Y]];
/** 도착점의 새 집 자리와, 지금까지 서비스하던 집이 서 있는 옆자리 */
const CLOUD_SLOT: Spot = [1050, 150];
const CLOUD_OLD_SLOT: Spot = [1128, 150];
const LOT_SLOT: Spot = [1020, GROUND];
const LOT_OLD_SLOT: Spot = [1097, GROUND];
const OLD_SCALE = 0.7;
const HOUSE_HEIGHT = 108;
const STOPPED_SPOT: Spot = [600, KORO_Y];

/** 단계별 집의 바닥 중심 좌표 (짓는 곳 → 이동 중 → 도착) */
const HOUSE_SITE: Spot = [520, GROUND];
function houseSpot(stage: number, onGround: boolean): Spot {
  if (stage <= 2) return HOUSE_SITE;
  if (stage === 3) return onGround ? [880, GROUND - 18] : [PLANE_AIR[0] - 38, PLANE_AIR[1] - PLANE_TOP];
  return onGround ? LOT_SLOT : CLOUD_SLOT;
}

/** 코로의 중심 좌표 (viewBox 1200×500 기준). 생각 풍선을 같은 자리에 띄우는 데도 쓴다. */
export function koroSpot(view: DeploymentStatusView, target: SceneTarget): Spot {
  if (view.stage === null) return STOPPED_SPOT;
  return (target === 'onprem' ? groundSpots : skySpots)[Math.min(view.stage, railStageCount)];
}
export const SCENE_SIZE = { width: 1200, height: 500, koro: KORO_SIZE } as const;
/** 장면이 보여 주는 세로 범위. 온프레미스 여정은 땅에서만 일어나므로 빈 하늘을 잘라 낸다. */
export function sceneBox(target: SceneTarget, story: DeployStory | null = null): { top: number; height: number } {
  const sky = target !== 'onprem' || (story?.prev != null && story.prev.target === 'aws');
  return sky ? { top: 0, height: SCENE_SIZE.height } : { top: 190, height: SCENE_SIZE.height - 190 };
}

type Windows = 'off' | 'checking' | 'on';
/** 집 한 채 (바닥 중심이 원점). 층수 · 지붕 · 창문 불빛 · 이미지 이름표 */
function House({ floors, roofed, windows, tag }: { floors: number; roofed: boolean; windows: Windows; tag: string | null }) {
  const light = windows === 'on' ? 'is-on' : windows === 'checking' ? 'is-checking' : '';
  return <>
    {Array.from({ length: floors }, (_, index) => <g key={index} className="jr-floor">
      <rect className="jr-paper" x="-40" y={-(index + 1) * FLOOR_HEIGHT} width="80" height={FLOOR_HEIGHT} />
      {index === 0
        ? <><rect className="jr-door" x="-8" y="-18" width="16" height="18" rx="2" /><rect className={`jr-window ${light}`} x="18" y="-19" width="12" height="11" rx="2" /></>
        : <><rect className={`jr-window ${light}`} x="-28" y={-(index + 1) * FLOOR_HEIGHT + 8} width="12" height="11" rx="2" /><rect className={`jr-window ${light}`} x="16" y={-(index + 1) * FLOOR_HEIGHT + 8} width="12" height="11" rx="2" /></>}
    </g>)}
    {roofed && <path className="jr-roof" d={`M-48 ${-FLOORS * FLOOR_HEIGHT} L0 ${-FLOORS * FLOOR_HEIGHT - 30} L48 ${-FLOORS * FLOOR_HEIGHT} Z`} />}
    {tag && floors > 0 && <g className="jr-tag">
      <rect x="-22" y="-13" width="44" height="17" rx="4" />
      <text x="0" y="0" textAnchor="middle">{tag}</text>
    </g>}
  </>;
}

/** 빌드 중에 올라간 층수. 빌드 단계에서 실제로 흐른 시간만큼 한 층씩 쌓고(최대 3층), 지붕은 빌드가 끝났을 때만 올린다. */
const FLOOR_SECONDS = 8;
const FLOORS = 3;
const FLOOR_HEIGHT = 26;

function place([x, y]: Spot): CSSProperties { return { transform: `translate(${x}px, ${y}px)` }; }

interface DeploySceneProps {
  view: DeploymentStatusView;
  target?: SceneTarget;
  /** 한 단계에 오래 머물 때의 모습 (일하는 중일 때만 쓴다) */
  idle?: { mood: KoroMood; dozing: boolean } | null;
  /** 지금 단계에서 실제로 흐른 시간(초). 빌드 중 집의 층수에 쓴다 */
  stepSeconds?: number;
  /** 재배포 · 롤백 · 환경 전환 정보. 없으면 처음 배포처럼 그린다 */
  story?: DeployStory | null;
}

export function DeployScene({ view, target = null, idle = null, stepSeconds = 0, story = null }: DeploySceneProps) {
  const { t } = useI18n();
  const stage = view.stage;
  const onGround = target === 'onprem';
  const rolling = view.outcome === 'active' && !view.waiting;
  const succeeded = view.outcome === 'success';
  const stopped = stage === null;
  const dozing = rolling && idle?.dozing === true;
  const mood: KoroMood = view.outcome === 'failed' ? 'flustered' : succeeded ? 'happy' : !rolling ? 'sleepy' : idle?.mood ?? 'normal';
  const working = (index: number) => rolling && stage === index;
  const reached = (index: number) => stage !== null && stage >= index;

  // 전에 만든 이미지를 재사용하면 집은 처음부터 다 지어진 채로 창고에서 나온다.
  const reused = story?.reused === true && reached(1);
  const floors = stopped || stage === 0 ? 0 : reused ? FLOORS : stage === 1 ? (rolling ? Math.min(FLOORS, 1 + Math.floor(stepSeconds / FLOOR_SECONDS)) : 0) : FLOORS;
  const roofed = reached(2) || reused;
  // 지금까지 서비스하던 버전: 그 버전이 있는 도착점의 옆자리에 서 있다. 환경을 모르면 이번 배포와 같은 곳으로 본다.
  const prev = story?.prev ?? null;
  const prevOnGround = prev ? (prev.target === null ? onGround : prev.target === 'onprem') : onGround;
  const showCloud = !onGround || (prev !== null && !prevOnGround);
  const showLot = onGround || (prev !== null && prevOnGround);
  const oldSlot = prevOnGround ? LOT_OLD_SLOT : CLOUD_OLD_SLOT;
  const house = houseSpot(stage ?? 0, onGround);
  const arrived = reached(4);

  const stageName = stage !== null && stage < railStageCount ? t.stages[railStages[stage]] : '';
  const label = view.outcome === 'failed' ? t.run.sceneFailed
    : succeeded ? t.run.sceneSucceeded
      : view.outcome !== 'active' ? t.run.sceneStopped
        : view.waiting === 'approval' ? t.run.sceneWaiting(stageName) : view.waiting === 'queue' ? t.run.sceneQueued(stageName)
          : (stage === 1 && reused ? t.run.sceneReuse : stage !== null ? (onGround ? t.run.sceneWorkOnprem : t.run.sceneWork)[stage] : undefined) ?? t.run.sceneActive(stageName);
  const fullLabel = prev && !succeeded ? `${label} · ${t.run.scenePrev(prev.label)}` : label;

  const [cx, cy] = koroSpot(view, target);

  const box = sceneBox(target, story);
  // LIVE 표지: 성공하기 전에는 지금까지 서비스하던 집 위에, 성공하면 새 집 위로 옮겨 간다.
  const liveAt: Spot | null = succeeded ? [house[0], house[1] - HOUSE_HEIGHT - 14] : prev ? [oldSlot[0], oldSlot[1] - HOUSE_HEIGHT * OLD_SCALE - 14] : null;
  const padClass = working(2) ? 'is-building' : reached(3) ? 'is-ready' : '';

  return <svg className={`deploy-scene is-${view.outcome}`} viewBox={`0 ${box.top} ${SCENE_SIZE.width} ${box.height}`} role="img" aria-label={fullLabel}>
    <line className="scene-floor" x1="20" y1={GROUND} x2="1180" y2={GROUND} />

    {/* 배포할 곳 — AWS: 구름 위 세계 · 온프레미스: 내 서버 옆 자리. 환경 전환이면 둘 다 그린다(집터는 이번에 갈 곳에만) */}
    {showLot && <g className="jr-dest">
      <rect className="jr-paper" x="1132" y="330" width="50" height="110" rx="5" />
      {[352, 374, 396, 418].map((y) => <g key={y}>
        <path className="jr-line" d={`M1140 ${y} H1162`} />
        <circle className={`jr-led ${(onGround && arrived) || (prev !== null && prevOnGround && !succeeded) ? 'is-on' : ''}`} cx="1172" cy={y} r="3" />
      </g>)}
      <text className="jr-sign" x="1157" y="322" textAnchor="middle">ON-PREM</text>
      {onGround && <rect className={`jr-pad ${padClass}`} x={LOT_SLOT[0] - 47} y={GROUND - 6} width="94" height="6" rx="2" />}
    </g>}
    {showCloud && <g className="jr-dest">
      <g className="jr-drift">
        <path className="jr-cloudlet" d="M120 96 h60 a14 14 0 0 0 0 -28 a20 20 0 0 0 -38 -6 a16 16 0 0 0 -22 34 z" />
        <path className="jr-cloudlet" d="M560 70 h44 a11 11 0 0 0 0 -22 a16 16 0 0 0 -30 -4 a12 12 0 0 0 -14 26 z" />
      </g>
      <ellipse className="jr-cloud" cx="945" cy="206" rx="46" ry="24" />
      <ellipse className="jr-cloud" cx="1035" cy="216" rx="56" ry="26" />
      <ellipse className="jr-cloud" cx="1125" cy="206" rx="46" ry="24" />
      <path className="jr-cloud" d="M900 150 H1160 A32 32 0 0 1 1160 214 H900 A32 32 0 0 1 900 150 Z" />
      {(target === 'aws' || onGround) && <text className="jr-sign" x="1030" y="192" textAnchor="middle">AWS</text>}
      {!onGround && <rect className={`jr-pad ${padClass}`} x={CLOUD_SLOT[0] - 47} y="144" width="94" height="6" rx="2" />}
      {!onGround && <path className="jr-route" d="M566 396 Q 800 330 960 230" />}
    </g>}

    {/* 지금까지 서비스하던 버전 — 이 배포가 성공하면 불이 꺼진다 */}
    {prev && <g className={`jr-old-house ${succeeded ? 'is-retired' : ''}`} style={{ transform: `translate(${oldSlot[0]}px, ${oldSlot[1]}px) scale(${OLD_SCALE})` }}>
      <House floors={FLOORS} roofed windows={succeeded ? 'off' : 'on'} tag={prev.label} />
    </g>}

    {/* 0 · 설계도 — 올린 소스(ZIP)를 읽어 배포 명세(IR)를 그린다 */}
    <g className="jr-zip">
      <rect className="jr-paper" x="34" y="408" width="46" height="32" rx="4" />
      <text className="scene-zip" x="57" y="429" textAnchor="middle">ZIP</text>
    </g>
    <g className={`jr-easel ${working(0) ? 'is-working' : reached(1) ? 'is-done' : ''}`}>
      <path className="jr-line" d="M122 372 L106 440 M208 372 L224 440" />
      <rect className="jr-paper" x="95" y="270" width="140" height="102" rx="6" />
      <text className="jr-board-title" x="107" y="290">IR</text>
      <path className="jr-draft" d="M110 304 H220" />
      <path className="jr-draft" d="M110 322 H196" />
      <path className="jr-draft" d="M110 340 H212" />
      <path className="jr-draft" d="M110 358 H170" />
    </g>

    {/* 1 · 집 짓는 곳 — 터와 비계 */}
    <rect className="jr-pad is-ready" x="476" y={GROUND - 6} width="88" height="6" rx="2" />
    {/* 이미지를 재사용하는 배포: 집을 짓지 않고 창고(이미지 저장소)에서 꺼낸다 */}
    {reused && <g className="jr-warehouse">
      <path className="jr-paper" d={`M446 ${GROUND} V352 Q520 318 594 352 V${GROUND} Z`} />
      <rect className="jr-warehouse__door" x="476" y="368" width="88" height="72" rx="3" />
      <text className="jr-sign jr-sign--small" x="520" y="312" textAnchor="middle">REGISTRY</text>
    </g>}
    {stage === 1 && !reused && <g className="jr-scaffold">
      <path className="jr-line" d={`M468 ${GROUND} V${GROUND - floors * FLOOR_HEIGHT - 26} M572 ${GROUND} V${GROUND - floors * FLOOR_HEIGHT - 26}`} />
      <path className="jr-line" d={`M468 ${GROUND - floors * FLOOR_HEIGHT - 14} H572`} />
    </g>}

    {/* 2 · 탈것 준비 — AWS: 바람을 넣는 풍선 · 온프레미스: 조립하는 수레 */}
    {!onGround && <g className={`jr-plane ${stage === 2 || stage === 3 ? 'is-shown' : ''} ${working(2) ? 'is-building' : ''} ${stage === 3 ? 'is-flying' : ''}`}
      style={place(stage !== null && stage >= 4 ? [1320, 240] : stage === 3 ? PLANE_AIR : PLANE_GROUND)}>
      {stage === 3 && <path className="jr-plane__wind" d="M-150 -52 H-118 M-164 -36 H-124 M-150 -20 H-118" />}
      <path className="jr-plane__tail" d="M-100 -60 L-122 -96 H-92 L-70 -64 Z" />
      <path className="jr-plane__body" d={`M-104 -${PLANE_TOP} H78 Q112 -${PLANE_TOP} 112 -39 Q112 -14 78 -14 H-70 Q-104 -14 -104 -${PLANE_TOP} Z`} />
      <path className="jr-plane__wing" d="M-26 -30 H44 L22 -6 H-46 Z" />
      {[-60, -30, 0].map((x) => <circle key={x} className="jr-plane__window" cx={x} cy="-46" r="6" />)}
      <path className="jr-line jr-line--thick" d="M-40 -14 V-4 M50 -14 V-4" />
      <circle className="jr-wheel" cx="-40" cy="-5" r="6" /><circle className="jr-wheel" cx="50" cy="-5" r="6" />
      <path className="jr-plane__prop" d="M116 -66 V-12" />
    </g>}
    {onGround && <g className={`jr-cart ${stage === 2 || stage === 3 ? 'is-shown' : ''}`} style={place(stage !== null && stage >= 4 ? LOT_SLOT : stage === 3 ? [880, GROUND] : [745, GROUND])}>
      <path className="jr-line jr-line--thick" d="M-48 -14 L-64 -42" />
      <rect className="jr-paper" x="-50" y="-18" width="100" height="9" rx="3" />
      <circle className="jr-wheel" cx="-30" cy="-7" r="7" />
      <circle className="jr-wheel" cx="30" cy="-7" r="7" />
    </g>}

    {/* 집 = 컨테이너 이미지. 한 번 지은 집이 그대로 배포할 곳까지 간다 */}
    <g className="jr-house" style={place(house)}>
      <House floors={floors} roofed={roofed} windows={arrived ? (succeeded ? 'on' : 'checking') : 'off'} tag={story ? story.label : null} />
    </g>

    {liveAt && <g className="jr-live" style={place(liveAt)}>
      <rect x="-25" y="-18" width="50" height="18" rx="9" />
      <path d="M-5 0 L0 7 L5 0 Z" />
      <text x="0" y="-5" textAnchor="middle">LIVE</text>
    </g>}

    <g className="scene-koro" style={place([cx - KORO_SIZE / 2, cy - KORO_SIZE / 2])}>
      <g className={rolling && !dozing ? 'scene-koro__bob' : undefined}>
        {/* 팔과 도구는 몸 뒤에, 안전모는 몸 앞에 그린다. 일하는 중이 아니거나 조는 동안에는 팔만 내린다 */}
        <KoroProp stage={succeeded ? 5 : rolling && !dozing ? stage : null} target={target} carrying={reused} />
        <Koro mood={mood} size={KORO_SIZE} />
        {rolling && !dozing && ((stage === 1 && !reused) || stage === 2) && <KoroHat />}
      </g>
      {dozing && <g className="scene-zzz" aria-hidden="true"><text x={KORO_SIZE - 4} y="4">z</text><text x={KORO_SIZE + 8} y="-10">z</text></g>}
    </g>
  </svg>;
}
