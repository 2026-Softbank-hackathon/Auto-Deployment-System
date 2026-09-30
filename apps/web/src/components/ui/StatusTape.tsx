import type { ReactNode } from 'react';
import type { MarbleTone } from './Marble';

/** 어두운 라벨 테이프. 색 점은 장식이며 상태는 항상 텍스트로 전달한다. */
export function StatusTape({ tone, children, className = '' }: { tone?: MarbleTone; children: ReactNode; className?: string }) {
  return <span className={`status-tape ${className}`}>
    {tone && <span className={`status-tape__dot status-tape__dot--${tone}`} aria-hidden="true" />}
    {children}
  </span>;
}
