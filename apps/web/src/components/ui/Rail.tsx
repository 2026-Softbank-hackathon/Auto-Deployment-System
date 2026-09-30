import type { CSSProperties, ReactNode } from 'react';

interface RailProps {
  orientation?: 'horizontal' | 'vertical';
  /** 완료 구간 비율(0~1). 정거장 인덱스에서 계산한 값만 넣는다 — 추정 진행률 금지. */
  progress?: number;
  className?: string;
  children?: ReactNode;
}

/** 선 + 정거장. 완료 구간은 --brass, 미완료는 --line. 네비게이션·파이프라인·미니 레일에 공통 사용. */
export function Rail({ orientation = 'horizontal', progress = 0, className = '', children }: RailProps) {
  const style = { '--rail-progress': Math.min(Math.max(progress, 0), 1) } as CSSProperties;
  return <div className={`rail rail--${orientation} ${className}`} style={style}>
    <span className="rail__track" aria-hidden="true" />
    <span className="rail__fill" aria-hidden="true" />
    {children}
  </div>;
}

export type RailStopState = 'done' | 'pending' | 'failed';

/** 작은 원형 정거장 */
export function RailStop({ state, className = '', style }: { state: RailStopState; className?: string; style?: CSSProperties }) {
  return <span className={`rail-stop rail-stop--${state} ${className}`} style={style} aria-hidden="true" />;
}
