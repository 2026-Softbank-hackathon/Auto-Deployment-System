import { useEffect, useState, type CSSProperties } from 'react';

const COLORS = ['var(--koro)', 'var(--moss)', 'var(--brass)', 'var(--brick)', 'var(--koro-tint)'];
const PIECES = 28;
/** 조각이 다 떨어진 뒤 DOM에서 치우는 시간. CSS의 confetti-fall 길이보다 조금 길게 둔다. */
const LIFETIME_MS = 2200;

/** 이 탭에서 그 배포의 성공을 이미 축하했는지. 결과 화면을 다시 열 때마다 터지지 않게 한다. */
function firstCelebration(key: string): boolean {
  try {
    const storageKey = `camellia.celebrated.${key}`;
    if (window.sessionStorage.getItem(storageKey)) return false;
    window.sessionStorage.setItem(storageKey, '1');
    return true;
  } catch { return true; }
}

/**
 * 배포 성공을 처음 볼 때 한 번 터지는 색종이. 장식이라 화면 낭독기에는 알리지 않는다.
 * 조각의 방향 · 거리 · 회전은 순서로 정해 둔 값이라 매번 같은 모양으로 퍼진다.
 * 움직임을 줄이도록 설정한 환경에서는 CSS가 조각을 숨긴다.
 */
export function Confetti({ celebrationKey }: { celebrationKey: string }) {
  const [show, setShow] = useState(() => firstCelebration(celebrationKey));
  useEffect(() => {
    if (!show) return;
    const timer = window.setTimeout(() => setShow(false), LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [show]);
  if (!show) return null;
  return <div className="confetti" aria-hidden="true">
    {Array.from({ length: PIECES }, (_, index) => {
      // 부채꼴로 퍼지게: 각도는 -80°~80°, 거리는 세 단계로 번갈아.
      const angle = -80 + (160 * index) / (PIECES - 1);
      const distance = 150 + (index % 3) * 70;
      const style = {
        '--x': `${Math.round(Math.sin((angle * Math.PI) / 180) * distance)}px`,
        '--y': `${Math.round(-Math.cos((angle * Math.PI) / 180) * distance * 0.7)}px`,
        '--spin': `${(index % 2 === 0 ? 1 : -1) * (240 + (index % 5) * 90)}deg`,
        '--delay': `${(index % 7) * 18}ms`,
        background: COLORS[index % COLORS.length],
      } as CSSProperties;
      return <span key={index} className={`confetti__piece ${index % 3 === 0 ? 'is-round' : ''}`} style={style} />;
    })}
  </div>;
}
