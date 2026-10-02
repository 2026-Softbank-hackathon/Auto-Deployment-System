import type { SceneTarget } from './DeployScene';

/**
 * 단계마다 코로가 하는 일을 보여 주는 팔과 도구. 코로 그림(72×72) 기준 좌표로 그리고, 코로와 같이 움직인다.
 *   0 분석      — 돋보기로 설계도를 살펴본다
 *   1 빌드      — 안전모를 쓰고 망치로 집(이미지)을 짓는다
 *   2 인프라 준비 — 렌치로 탈것을 조립한다 (AWS: 비행기 · 온프레미스: 수레)
 *   3 배포      — AWS: 비행기 등에 타고 손을 흔든다 · 온프레미스: 수레를 민다
 *   4 검증      — 점검표에 체크한다
 *   5 완료      — 두 팔을 들고 기뻐한다
 * 반복 동작일 뿐 진행률을 뜻하지 않는다. 움직임은 CSS에서 prefers-reduced-motion: no-preference 일 때만 건다.
 */
function Arm({ d, hand }: { d: string; hand: readonly [number, number] }) {
  return <><path className="koro-arm" d={d} /><circle className="koro-hand" cx={hand[0]} cy={hand[1]} r="5.5" /></>;
}
const LeftIdle = () => <Arm d="M8 46 Q0 54 4 62" hand={[4, 62]} />;
const RightIdle = () => <Arm d="M64 46 Q72 54 68 62" hand={[68, 62]} />;

/** 코로 몸 뒤에 그리는 팔과 도구. stage = null 이면 팔만 내린다. */
export function KoroProp({ stage, target }: { stage: number | null; target: SceneTarget }) {
  switch (stage) {
    case 0:
      return <g className="koro-prop">
        <RightIdle />
        <g className="koro-prop--scan">
          <Arm d="M8 42 L-8 34" hand={[-8, 34]} />
          <path className="koro-prop__line koro-prop__line--thick" d="M-9 35 L-16 30" />
          <circle className="koro-prop__glass" cx="-26" cy="21" r="13" />
        </g>
      </g>;
    case 1:
      return <g className="koro-prop">
        <LeftIdle />
        <g className="koro-prop--hammer">
          <Arm d="M64 42 L80 30" hand={[80, 30]} />
          <path className="koro-prop__line koro-prop__line--thick" d="M80 30 L92 9" />
          <rect className="koro-prop__solid" x="81" y="-1" width="24" height="13" rx="3" transform="rotate(30 93 6)" />
        </g>
      </g>;
    case 2:
      return <g className="koro-prop">
        <LeftIdle />
        <g className="koro-prop--wrench">
          <Arm d="M64 42 L80 34" hand={[80, 34]} />
          <path className="koro-prop__line koro-prop__line--thick" d="M80 34 L93 20" />
          <path className="koro-prop__line koro-prop__line--thick" d="M90 13 A8 8 0 1 0 101 24" />
        </g>
      </g>;
    case 3:
      return target === 'onprem'
        ? <g className="koro-prop koro-prop--push">
          <Arm d="M60 34 L84 30" hand={[84, 30]} />
          <Arm d="M60 48 L84 46" hand={[84, 46]} />
        </g>
        : <g className="koro-prop">
          <LeftIdle />
          <g className="koro-prop--wave"><Arm d="M62 36 L80 18" hand={[80, 18]} /></g>
        </g>;
    case 4:
      return <g className="koro-prop">
        <LeftIdle />
        <Arm d="M64 42 L80 38" hand={[80, 38]} />
        <rect className="koro-prop__box" x="80" y="12" width="28" height="36" rx="3" />
        <rect className="koro-prop__solid" x="88" y="8" width="12" height="7" rx="2" />
        <g className="koro-prop--ticks">
          <path className="koro-prop__tick" d="M86 23 l3 3 l7 -7" />
          <path className="koro-prop__tick" d="M86 32 l3 3 l7 -7" />
          <path className="koro-prop__tick" d="M86 41 l3 3 l7 -7" />
        </g>
      </g>;
    case 5:
      return <g className="koro-prop">
        <g className="koro-prop--cheer-left"><Arm d="M10 34 L-4 14" hand={[-4, 14]} /></g>
        <g className="koro-prop--cheer-right"><Arm d="M62 34 L76 14" hand={[76, 14]} /></g>
      </g>;
    default:
      return <g className="koro-prop"><LeftIdle /><RightIdle /></g>;
  }
}

/** 코로 몸 앞에 그리는 안전모 (빌드 · 인프라 준비) */
export function KoroHat() {
  return <g className="koro-prop__hat">
    <path d="M12 12 A24 18 0 0 1 60 12 Z" />
    <path className="koro-prop__line" d="M5 13 H67" />
    <path className="koro-prop__line" d="M36 -5 V11" />
  </g>;
}
