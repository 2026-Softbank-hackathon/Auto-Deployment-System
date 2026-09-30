export type KoroMood = 'normal' | 'happy' | 'sleepy' | 'flustered';

interface KoroProps {
  mood?: KoroMood;
  size?: number;
  /** 다른 SVG 장면 안에 넣을 때의 위치 */
  x?: number;
  y?: number;
  /** 있으면 의미 있는 이미지로, 없으면 장식으로 취급한다. */
  label?: string;
  className?: string;
}

function Eyes({ mood }: { mood: KoroMood }) {
  switch (mood) {
    case 'sleepy':
      return <><path className="koro__stroke" d="M14 24 H26" /><path className="koro__stroke" d="M34 24 H46" /></>;
    case 'happy':
      return <><path className="koro__stroke" d="M14 27 Q20 17 26 27" /><path className="koro__stroke" d="M34 27 Q40 17 46 27" /></>;
    case 'flustered':
      return <>
        <circle className="koro__eye" cx="21" cy="24" r="7" /><circle className="koro__eye" cx="39" cy="24" r="7" />
        <circle className="koro__pupil" cx="21" cy="24" r="2" /><circle className="koro__pupil" cx="39" cy="24" r="2" />
        <path className="koro__sweat" d="M50 8 Q54 14 50 17 Q46 14 50 8 Z" />
      </>;
    default:
      return <>
        <circle className="koro__eye" cx="21" cy="24" r="7" /><circle className="koro__eye" cx="39" cy="24" r="7" />
        <circle className="koro__pupil" cx="22.5" cy="25" r="3.5" /><circle className="koro__pupil" cx="40.5" cy="25" r="3.5" />
      </>;
  }
}

/** 파란 구슬 캐릭터 "코로". 등장 위치는 배포 버튼, 배포 중, 성공, 실패, 빈 상태로 한정 (DESIGN_SPEC §5). */
export function Koro({ mood = 'normal', size = 60, x, y, label, className = '' }: KoroProps) {
  return <svg className={`koro ${className}`} x={x} y={y} width={size} height={size} viewBox="0 0 60 60"
    role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
    <circle className="koro__body" cx="30" cy="30" r="28" />
    <path className="koro__shine" d="M14 18 A16 16 0 0 1 26 8" />
    <Eyes mood={mood} />
  </svg>;
}
