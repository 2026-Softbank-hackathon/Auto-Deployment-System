export type MarbleTone = 'running' | 'success' | 'failed' | 'waiting';

/** 상태 구슬. 색은 보조 수단이고, 상태 텍스트는 항상 옆에 따로 둔다. */
export function Marble({ tone, size = 18, className = '' }: { tone: MarbleTone; size?: number; className?: string }) {
  return <span className={`marble marble--${tone} ${className}`} style={{ width: size, height: size }} aria-hidden="true" />;
}
