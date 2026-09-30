import type { MouseEvent } from 'react';

export type Navigate = (path: string) => void;

/** 앱 내부 <a href> 클릭을 history 내비게이션으로 처리한다. 새 탭 열기(⌘/Ctrl/Shift/휠 클릭)는 브라우저 기본 동작에 맡긴다. */
export function followAppLink(event: MouseEvent<HTMLAnchorElement>, navigate: Navigate): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const href = event.currentTarget.getAttribute('href');
  if (!href) return;
  event.preventDefault();
  navigate(href);
}
