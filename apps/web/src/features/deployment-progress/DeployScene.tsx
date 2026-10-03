import type { CSSProperties } from 'react';
import { Koro, type KoroMood } from '../../components/ui/Koro';
import { useI18n } from '../../i18n/I18nProvider';
import { railStageCount, railStages, type DeploymentStatusView } from '../deployment-status/status-view';
import type { DeployStory, IrOrigin } from './deploy-story';
import { KoroHat, KoroProp } from './KoroProp';

/**
 * 배포 여정 장면. 코로가 앱을 "집"으로 지어서 배포할 곳까지 옮긴다.
 *   0 분석      — 설계도(IR)를 살펴본다
 *   1 빌드      — 집(컨테이너 이미지)을 짓는다. 층이 올라간다
 *   2 인프라 준비 — AWS: 구름 위 자리를 만들고 땅에서 비행기를 조립한다(Terraform) · 온프레미스: 에이전트 로봇에게 집을 넘긴다
 *   3 배포      — AWS: 집을 비행기에 싣고 구름으로 날아간다(새 버전이 켜지기를 기다리는 ECS 롤아웃, #253)
 *                 · 온프레미스: 에이전트 로봇이 집을 이고 서버 옆으로 알아서 옮긴다
 *   4 검증      — 도착한 집에 불이 들어오는지 점검한다
 *   5 완료      — 집에 깃발이 오른다
 * 같은 집이 배포할 곳에 따라 다른 길로 간다(같은 이미지, 다른 환경).
 *
 * 재배포 · 롤백 · 환경 전환 (story):
 *   - 지금까지 서비스하던 버전은 도착점 옆자리에 작은 집으로 서 있고, LIVE 표지가 그 위에 있다.
 *     이 배포가 성공하면 표지가 새 집으로 옮겨 간다. 옛 집은 그대로 불이 켜져 있다
 *     (온프레미스의 이전 컨테이너도, 환경 전환 뒤의 옛 환경도 실제로 계속 떠 있다 — 주소만 가리키지 않는다).
 *   - 예외: AWS의 같은 환경 배포(업데이트 · 롤백)는 서비스 하나를 제자리에서 교체한다(ECS 롤링).
 *     그래서 옛 집이 집터에 서 있다가, 새 집이 도착하면(검증 단계) 그 자리를 넘겨주고 사라진다.
 *   - 환경 전환이면 두 도착점(구름 · 서버 옆)을 함께 그린다.
 *   - 전에 만든 이미지를 재사용하면 집을 짓지 않고 창고(이미지 저장소)에서 꺼낸다.
 *   - 환경 전환(이미지 재사용)은 창고를 거치지 않고, 지금 환경에 있는 집과 같은 집이 다른 환경으로 건너간다:
 *     AWS → 온프레미스는 구름에서 낙하산으로 내려오고, 온프레미스 → AWS는 서버 옆에서 비행기에 실려 올라간다.
 *     (실제로는 같은 이미지를 저장소에서 받아 새 환경에 띄운다. 옛 환경의 집은 성공할 때까지 그대로 서비스한다.)
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
/**
 * 비행기의 바닥 중심 좌표: 조립하는 곳(땅) → 날아가는 중(하늘). 집과 코로는 비행기 등(PLANE_TOP 높이)에 탄다.
 * 날아가는 자리는 구름에서 떨어진 길 중간이다 — 배포 단계 내내 여기 머무르므로, 코로의 생각 풍선이 구름 위의 집(서비스 중인 버전)을 가리지 않게 한다.
 */
const PLANE_GROUND: Spot = [800, GROUND];
const PLANE_AIR: Spot = [640, 295];
/** 환경 전환(온프레미스 → AWS)은 장면을 탈것 준비하는 곳부터 잘라 보여 주고 구름 위에 서비스 중인 집도 없으므로, 구름 가까이에서 난다 */
const PLANE_AIR_MOVING: Spot = [900, 340];
const PLANE_TOP = 64;
function planeAir(moving: boolean): Spot { return moving ? PLANE_AIR_MOVING : PLANE_AIR; }
/** 비행기 등에 탄 코로의 중심 좌표 */
function koroOnPlane(moving: boolean): Spot { const [x, y] = planeAir(moving); return [x + 55, y - PLANE_TOP - KORO_SIZE / 2]; }
/** 단계별 코로 중심 좌표 (0 설계도 · 1 집 짓는 곳 · 2 탈것 준비 · 3 이동 중 · 4 도착 · 5 완료) */
const skySpots: readonly Spot[] = [[285, KORO_Y], [415, KORO_Y], [640, KORO_Y], koroOnPlane(false), [950, 114], [950, 114]];
// 온프레미스: 집을 지은 뒤에는 에이전트 로봇이 알아서 옮긴다. 코로는 집 짓는 곳에서 넘겨주고 지켜보다가, 검증 때 서버 옆으로 간다.
const groundSpots: readonly Spot[] = [[285, KORO_Y], [415, KORO_Y], [415, KORO_Y], [415, KORO_Y], [880, KORO_Y], [880, KORO_Y]];
/** 에이전트 로봇의 바닥 중심: 서버 옆 대기 자리 → 집 옆(넘겨받기) → 집을 이고 가는 중 */
const ROBOT_DOCK: Spot = [950, GROUND];
const ROBOT_PICKUP: Spot = [600, GROUND];
const ROBOT_CARRY: Spot = [800, GROUND];
const ROBOT_TOP = 58;
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
function houseSpot(stage: number, onGround: boolean, moving: boolean): Spot {
  if (stage <= 2) return HOUSE_SITE;
  if (stage === 3) return onGround ? [ROBOT_CARRY[0], GROUND - ROBOT_TOP] : [planeAir(moving)[0] - 38, planeAir(moving)[1] - PLANE_TOP];
  return onGround ? LOT_SLOT : CLOUD_SLOT;
}

/** 코로의 중심 좌표 (viewBox 1200×500 기준). 생각 풍선을 같은 자리에 띄우는 데도 쓴다. */
export function koroSpot(view: DeploymentStatusView, target: SceneTarget, story: DeployStory | null = null): Spot {
  if (view.stage === null) return STOPPED_SPOT;
  const stage = Math.min(view.stage, railStageCount);
  if (isMoving(story)) {
    // 환경 전환: 집을 짓지 않으니 짓는 곳에 서지 않는다. 온프레미스로 내려올 때는 집터 옆에서 기다린다.
    if (stage === 1) return [640, KORO_Y];
    if (target === 'onprem' && stage >= 2) return groundSpots[4];
    if (stage === 3) return koroOnPlane(true);
  }
  return (target === 'onprem' ? groundSpots : skySpots)[stage];
}
/** 환경 전환이면서 이미지를 재사용하는 배포 — 집이 지금 환경에서 다른 환경으로 건너간다 */
function isMoving(story: DeployStory | null): boolean {
  return story !== null && story.kind === 'switch' && story.reused && story.prev !== null;
}
/** 복사한 IR 판을 세우는 데 쓰는 가로 폭 (잘라 낸 장면의 왼쪽 끝) */
const IR_STAND_ROOM = 110;
/**
 * 장면에 그려진 IR 판의 오른쪽 위 모서리 (IR 보기 말풍선을 붙이는 자리). IR 판이 없으면 null.
 *   - 설계도 판(큰 판): 이미지를 새로 짓는 배포에 그린다
 *   - 복사한 IR 판(작은 판): 이미지를 재사용하면서 IR을 복사한 배포에 그린다
 */
export function irBoardSpot(target: SceneTarget, story: DeployStory | null, ir: IrOrigin | null): Spot | null {
  if (!story?.reused) return [235, 270];
  if (ir !== 'copied') return null;
  return [sceneBox(target, story, ir).left + IR_STAND_X + 42, GROUND - 92];
}
/** 잘라 낸 장면의 왼쪽 끝에서 복사한 IR 판의 중심까지 */
const IR_STAND_X = 58;
/** 낙하산으로 내려오는 중인 집의 바닥 중심 */
const PARACHUTE_AIR: Spot = [1035, 310];
export const SCENE_SIZE = { width: 1200, height: 500, koro: KORO_SIZE } as const;
/** 장면이 보여 주는 세로 범위. 온프레미스 여정은 땅에서만 일어나므로 빈 하늘을 잘라 낸다. */
/**
 * 가로 범위도 줄인다: 이미지를 재사용하는 배포는 분석 · 빌드를 하지 않으므로 설계도와 집 짓는 곳을 그리지 않는다.
 * (같은 환경 재배포 · 롤백은 창고부터, 환경 전환은 탈것을 준비하는 곳부터 보여 준다.)
 */
export function sceneBox(target: SceneTarget, story: DeployStory | null = null, ir: IrOrigin | null = null): { left: number; top: number; width: number; height: number } {
  const sky = target !== 'onprem' || (story?.prev != null && story.prev.target === 'aws');
  // 복사한 IR을 쓰는 배포는 잘라 낸 장면 왼쪽에 "복사한 IR" 판을 세울 자리를 남긴다.
  const left = !story?.reused ? 0 : (isMoving(story) ? 580 : 360) - (ir === 'copied' ? IR_STAND_ROOM : 0);
  return { left, width: SCENE_SIZE.width - left, ...(sky ? { top: 0, height: SCENE_SIZE.height } : { top: 190, height: SCENE_SIZE.height - 190 }) };
}

/**
 * 다 지었을 때의 층수. 버전 업데이트(서비스 중인 버전이 있는 앱에 새로 빌드해서 올리는 배포)는
 * 지금 서비스 중인 집보다 한 층 높은 집을 짓는다 — 처음 배포와 구분하고, "더 새 버전으로 바꾼다"를 보여 준다.
 */
export function houseFloors(story: DeployStory | null): number {
  return story?.kind === 'update' && !story.reused ? FLOORS + 1 : FLOORS;
}

type Windows = 'off' | 'checking' | 'on';
/** 집 한 채 (바닥 중심이 원점). 층수 · 지붕 · 창문 불빛 · 이미지 이름표 */
function House({ floors, total = FLOORS, roofed, windows, tag }: { floors: number; /** 다 지었을 때의 층수 (지붕 높이) */ total?: number; roofed: boolean; windows: Windows; tag: string | null }) {
  const light = windows === 'on' ? 'is-on' : windows === 'checking' ? 'is-checking' : '';
  return <>
    {Array.from({ length: floors }, (_, index) => <g key={index} className="jr-floor">
      <rect className="jr-paper" x="-40" y={-(index + 1) * FLOOR_HEIGHT} width="80" height={FLOOR_HEIGHT} />
      {index === 0
        ? <><rect className="jr-door" x="-8" y="-18" width="16" height="18" rx="2" /><rect className={`jr-window ${light}`} x="18" y="-19" width="12" height="11" rx="2" /></>
        : <><rect className={`jr-window ${light}`} x="-28" y={-(index + 1) * FLOOR_HEIGHT + 8} width="12" height="11" rx="2" /><rect className={`jr-window ${light}`} x="16" y={-(index + 1) * FLOOR_HEIGHT + 8} width="12" height="11" rx="2" /></>}
    </g>)}
    {roofed && <path className="jr-roof" d={`M-48 ${-total * FLOOR_HEIGHT} L0 ${-total * FLOOR_HEIGHT - 30} L48 ${-total * FLOOR_HEIGHT} Z`} />}
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
  /** 이번 배포의 IR이 어디서 왔는지. 모르면 null (출처 도장을 찍지 않는다) */
  ir?: IrOrigin | null;
}

export function DeployScene({ view, target = null, idle = null, stepSeconds = 0, story = null, ir = null }: DeploySceneProps) {
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
  const total = houseFloors(story);
  const floors = stopped || stage === 0 ? 0 : reused ? total : stage === 1 ? (rolling ? Math.min(total, 1 + Math.floor(stepSeconds / FLOOR_SECONDS)) : 0) : total;
  const roofed = reached(2) || reused;
  // 지금까지 서비스하던 버전: 그 버전이 있는 도착점의 옆자리에 서 있다. 환경을 모르면 이번 배포와 같은 곳으로 본다.
  const prev = story?.prev ?? null;
  const prevOnGround = prev ? (prev.target === null ? onGround : prev.target === 'onprem') : onGround;
  const showCloud = !onGround || (prev !== null && !prevOnGround);
  const showLot = onGround || (prev !== null && prevOnGround);
  const arrived = reached(4);
  // AWS의 같은 환경 배포는 제자리 교체다: 옛 집이 집터에 서 있다가 새 집이 도착하면 자리를 넘겨준다.
  const inPlace = prev !== null && !onGround && !prevOnGround;
  const oldSlot = inPlace ? CLOUD_SLOT : prevOnGround ? LOT_OLD_SLOT : CLOUD_OLD_SLOT;
  const oldScale = inPlace ? 1 : OLD_SCALE;
  const oldShown = prev !== null && !(inPlace && arrived);
  // 환경 전환: 집은 옛 환경의 집 자리에서 출발한다(배포 단계 전에는 옛 집에 겹쳐 있으므로 숨긴다).
  const moving = isMoving(story) && reached(1);
  const parachuting = moving && onGround && stage === 3;
  const house: Spot = moving && stage !== null && stage <= 2 ? oldSlot : parachuting ? PARACHUTE_AIR : houseSpot(stage ?? 0, onGround, moving);

  const stageName = stage !== null && stage < railStageCount ? t.stages[railStages[stage]] : '';
  const label = view.outcome === 'failed' ? t.run.sceneFailed
    : succeeded ? t.run.sceneSucceeded
      : view.outcome !== 'active' ? t.run.sceneStopped
        : view.waiting === 'approval' ? t.run.sceneWaiting(stageName) : view.waiting === 'queue' ? t.run.sceneQueued(stageName)
          : (stage === 1 && moving ? t.run.sceneMove : moving && onGround && stage === 2 ? t.run.sceneLanding : parachuting ? t.run.sceneParachute : stage === 1 && reused ? t.run.sceneReuse : stage !== null ? (onGround ? t.run.sceneWorkOnprem : t.run.sceneWork)[stage] : undefined) ?? t.run.sceneActive(stageName);
  const prevLabel = prev && !succeeded && !(inPlace && arrived) ? `${label} · ${t.run.scenePrev(prev.label)}` : label;
  const fullLabel = ir !== null && stage !== null && stage >= 1 && !succeeded ? `${prevLabel} · ${t.run.sceneIr[ir]}` : prevLabel;

  const [cx, cy] = koroSpot(view, target, story);

  const handingOff = onGround && !moving && (stage === 2 || stage === 3);
  const box = sceneBox(target, story, ir);
  // IR 출처 도장: 새로 만들었으면 NEW(AI가 채웠으면 NEW · AI), 이전 배포 것을 복사했으면 COPY. 분석이 끝난 뒤에만 찍는다.
  const irStamp = ir !== null && reached(1) ? (ir === 'copied' ? 'COPY' : ir === 'ai' ? 'NEW · AI' : 'NEW') : null;
  const irStandX = box.left + IR_STAND_X;
  // LIVE 표지: 성공하기 전에는 지금까지 서비스하던 집 위에, 성공하면 새 집 위로 옮겨 간다.
  // 제자리 교체(AWS 같은 환경)는 새 집이 도착한 순간부터 새 버전이 서비스하므로 그때 표지를 옮긴다.
  const liveAt: Spot | null = succeeded || (inPlace && arrived) ? [house[0], house[1] - (total * FLOOR_HEIGHT + 30) - 14] : prev ? [oldSlot[0], oldSlot[1] - HOUSE_HEIGHT * oldScale - 14] : null;
  const padClass = working(2) ? 'is-building' : reached(3) ? 'is-ready' : '';

  return <svg className={`deploy-scene is-${view.outcome}`} viewBox={`${box.left} ${box.top} ${box.width} ${box.height}`} role="img" aria-label={fullLabel}>
    <line className="scene-floor" x1={box.left + 20} y1={GROUND} x2="1180" y2={GROUND} />

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
      {/* 장식 구름은 장면을 잘라 냈을 때는 그리지 않는다(잘린 범위 밖에 있다) */}
      {box.left === 0 && <g className="jr-drift">
        <path className="jr-cloudlet" d="M120 96 h60 a14 14 0 0 0 0 -28 a20 20 0 0 0 -38 -6 a16 16 0 0 0 -22 34 z" />
        <path className="jr-cloudlet" d="M560 70 h44 a11 11 0 0 0 0 -22 a16 16 0 0 0 -30 -4 a12 12 0 0 0 -14 26 z" />
      </g>}
      <ellipse className="jr-cloud" cx="945" cy="206" rx="46" ry="24" />
      <ellipse className="jr-cloud" cx="1035" cy="216" rx="56" ry="26" />
      <ellipse className="jr-cloud" cx="1125" cy="206" rx="46" ry="24" />
      <path className="jr-cloud" d="M900 150 H1160 A32 32 0 0 1 1160 214 H900 A32 32 0 0 1 900 150 Z" />
      {(target === 'aws' || onGround) && <text className="jr-sign" x="1030" y="192" textAnchor="middle">AWS</text>}
      {!onGround && <rect className={`jr-pad ${inPlace ? 'is-ready' : padClass}`} x={CLOUD_SLOT[0] - 47} y="144" width="94" height="6" rx="2" />}
      {!onGround && !moving && <path className="jr-route" d="M566 396 Q 800 330 960 230" />}
    </g>}

    {/* 지금까지 서비스하던 버전. 성공해도 불은 켜져 있다(실제로 계속 떠 있다). AWS 제자리 교체만 새 집이 도착하면 사라진다 */}
    {prev && oldShown && <g className="jr-old-house" style={{ transform: `translate(${oldSlot[0]}px, ${oldSlot[1]}px) scale(${oldScale})` }}>
      <House floors={FLOORS} roofed windows="on" tag={prev.label} />
    </g>}

    {/* 0 · 설계도 — 올린 소스(ZIP)를 읽어 배포 명세(IR)를 그린다 */}
    {!reused && <g className="jr-zip">
      <rect className="jr-paper" x="34" y="408" width="46" height="32" rx="4" />
      <text className="scene-zip" x="57" y="429" textAnchor="middle">ZIP</text>
    </g>}
    {!reused && <g className={`jr-easel ${working(0) ? 'is-working' : reached(1) ? 'is-done' : ''}`}>
      <path className="jr-line" d="M122 372 L106 440 M208 372 L224 440" />
      <rect className="jr-paper" x="95" y="270" width="140" height="102" rx="6" />
      <text className="jr-board-title" x="107" y="290">IR</text>
      <path className="jr-draft" d="M110 304 H220" />
      <path className="jr-draft" d="M110 322 H196" />
      <path className="jr-draft" d="M110 340 H212" />
      <path className="jr-draft" d="M110 358 H170" />
      {irStamp && <g className={`jr-stamp ${ir === 'copied' ? 'is-copy' : 'is-new'}`} transform="translate(196 286)">
        <rect x={-(irStamp.length * 4 + 8)} y="-11" width={irStamp.length * 8 + 16} height="20" rx="4" />
        <text x="0" y="4" textAnchor="middle">{irStamp}</text>
      </g>}
    </g>}
    {/* 이미지를 재사용하는 배포(재배포 · 롤백 · 환경 전환)는 분석을 하지 않고 이전 배포의 IR을 그대로 복사해 쓴다.
        설계도 자리는 잘라 냈으므로, 복사해 온 IR을 작은 판으로 왼쪽 끝에 세운다 */}
    {reused && ir === 'copied' && <g className="jr-ir-copy" style={place([irStandX, GROUND])}><g className="jr-ir-copy__body">
      <path className="jr-line" d="M-22 -30 L-30 0 M22 -30 L30 0" />
      <rect className="jr-paper" x="-42" y="-92" width="84" height="62" rx="5" />
      <text className="jr-board-title" x="-33" y="-75">IR</text>
      <path className="jr-draft" d="M-32 -62 H32" />
      <path className="jr-draft" d="M-32 -48 H16" />
      <g className="jr-stamp is-copy" transform="translate(14 -76)">
        <rect x="-24" y="-11" width="48" height="20" rx="4" />
        <text x="0" y="4" textAnchor="middle">COPY</text>
      </g>
    </g></g>}

    {/* 1 · 집 짓는 곳 — 터와 비계 */}
    {!moving && <rect className="jr-pad is-ready" x="476" y={GROUND - 6} width="88" height="6" rx="2" />}
    {/* 이미지를 재사용하는 배포: 집을 짓지 않고 창고(이미지 저장소)에서 꺼낸다 */}
    {reused && !moving && <g className="jr-warehouse">
      <path className="jr-paper" d={`M446 ${GROUND} V352 Q520 318 594 352 V${GROUND} Z`} />
      <rect className="jr-warehouse__door" x="476" y="368" width="88" height="72" rx="3" />
      <text className="jr-sign jr-sign--small" x="520" y="312" textAnchor="middle">REGISTRY</text>
    </g>}
    {stage === 1 && !reused && <g className="jr-scaffold">
      <path className="jr-line" d={`M468 ${GROUND} V${GROUND - floors * FLOOR_HEIGHT - 26} M572 ${GROUND} V${GROUND - floors * FLOOR_HEIGHT - 26}`} />
      <path className="jr-line" d={`M468 ${GROUND - floors * FLOOR_HEIGHT - 14} H572`} />
    </g>}

    {/* 2 · 탈것 준비 — AWS: 조립하는 비행기 */}
    {!onGround && <g className={`jr-plane ${stage === 2 || stage === 3 ? 'is-shown' : ''} ${working(2) ? 'is-building' : ''} ${stage === 3 ? 'is-flying' : ''}`}
      style={place(stage !== null && stage >= 4 ? [1320, 240] : stage === 3 ? planeAir(moving) : PLANE_GROUND)}>
      {stage === 3 && <path className="jr-plane__wind" d="M-150 -52 H-118 M-164 -36 H-124 M-150 -20 H-118" />}
      <path className="jr-plane__tail" d="M-100 -60 L-122 -96 H-92 L-70 -64 Z" />
      <path className="jr-plane__body" d={`M-104 -${PLANE_TOP} H78 Q112 -${PLANE_TOP} 112 -39 Q112 -14 78 -14 H-70 Q-104 -14 -104 -${PLANE_TOP} Z`} />
      <path className="jr-plane__wing" d="M-26 -30 H44 L22 -6 H-46 Z" />
      {[-60, -30, 0].map((x) => <circle key={x} className="jr-plane__window" cx={x} cy="-46" r="6" />)}
      <path className="jr-line jr-line--thick" d="M-40 -14 V-4 M50 -14 V-4" />
      <circle className="jr-wheel" cx="-40" cy="-5" r="6" /><circle className="jr-wheel" cx="50" cy="-5" r="6" />
      <path className="jr-plane__prop" d="M116 -66 V-12" />
    </g>}
    {/* 온프레미스의 에이전트 로봇. 서버 옆에 대기하다가, 일을 넘겨받으면 집 옆으로 와서 집을 이고 서버 옆까지 알아서 옮긴다 */}
    {onGround && <g className={`jr-robot ${!moving && stage === 3 ? 'is-carrying' : ''} ${!moving && working(2) ? 'is-called' : ''}`}
      style={place(moving || stage === null || stage < 2 || stage >= 4 ? ROBOT_DOCK : stage === 2 ? ROBOT_PICKUP : ROBOT_CARRY)}>
      {!moving && stage === 3 && <path className="jr-plane__wind" d="M-62 -40 H-38 M-70 -26 H-40 M-62 -12 H-38" />}
      {!moving && stage === 3
        ? <path className="jr-line jr-line--thick" d={`M-18 -40 L-28 -${ROBOT_TOP} M18 -40 L28 -${ROBOT_TOP} M-44 -${ROBOT_TOP} H44`} />
        : <path className="jr-line jr-line--thick" d="M-20 -34 L-28 -20 M20 -34 L28 -20" />}
      <rect className="jr-robot__track" x="-24" y="-12" width="48" height="12" rx="6" />
      <rect className="jr-paper" x="-20" y="-46" width="40" height="34" rx="6" />
      <rect className="jr-robot__visor" x="-13" y="-40" width="26" height="11" rx="4" />
      <circle className="jr-robot__eye" cx="-6" cy="-34.5" r="2.5" /><circle className="jr-robot__eye" cx="6" cy="-34.5" r="2.5" />
      <path className="jr-line" d="M0 -46 V-54" /><circle className="jr-robot__antenna" cx="0" cy="-57" r="3.5" />
      <text className="jr-robot__name" x="0" y="-18" textAnchor="middle">AGENT</text>
    </g>}

    {/* 집 = 컨테이너 이미지. 한 번 지은 집이 그대로 배포할 곳까지 간다 */}
    <g className={`jr-house ${moving && stage !== null && stage <= 2 ? 'is-hidden' : ''}`} style={place(house)}>
      {parachuting && <g className="jr-parachute">
        <path className="jr-line" d="M-58 -152 L-44 -80 M58 -152 L44 -80 M0 -176 V-108" />
        <path className="jr-parachute__canopy" d="M-62 -150 Q0 -232 62 -150 Q31 -166 0 -150 Q-31 -166 -62 -150 Z" />
      </g>}
      <House floors={floors} total={total} roofed={roofed} windows={arrived ? (succeeded ? 'on' : 'checking') : 'off'} tag={story ? story.label : null} />
    </g>

    {liveAt && <g className="jr-live" style={place(liveAt)}>
      <rect x="-25" y="-18" width="50" height="18" rx="9" />
      <path d="M-5 0 L0 7 L5 0 Z" />
      <text x="0" y="-5" textAnchor="middle">LIVE</text>
    </g>}

    <g className="scene-koro" style={place([cx - KORO_SIZE / 2, cy - KORO_SIZE / 2])}>
      <g className={rolling && !dozing ? 'scene-koro__bob' : undefined}>
        {/* 팔과 도구는 몸 뒤에, 안전모는 몸 앞에 그린다. 일하는 중이 아니거나 조는 동안에는 팔만 내린다 */}
        {/* 온프레미스(전환이 아닐 때)의 인프라 준비 · 배포: 코로는 로봇에게 넘겨주고 손을 흔든다 */}
        <KoroProp stage={succeeded ? 5 : !rolling || dozing || (moving && stage === 1) ? null : handingOff ? 3 : stage} carrying={reused && !moving} />
        <Koro mood={mood} size={KORO_SIZE} />
        {rolling && !dozing && ((stage === 1 && !reused) || (stage === 2 && !handingOff)) && <KoroHat />}
      </g>
      {dozing && <g className="scene-zzz" aria-hidden="true"><text x={KORO_SIZE - 4} y="4">z</text><text x={KORO_SIZE + 8} y="-10">z</text></g>}
    </g>
  </svg>;
}
