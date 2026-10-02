import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { followAppLink, type Navigate } from '../../app/navigation';
import { useI18n } from '../../i18n/I18nProvider';

export interface RowMenuItem {
  key: string;
  label: string;
  /** 화면 이동이면 href, 동작이면 onSelect */
  href?: string;
  onSelect?: () => void;
  /** 지금은 할 수 없는 동작. 이유를 같이 보여 준다 */
  disabledReason?: string;
}

/** 화면 가장자리와 메뉴 사이에 남길 여백 */
const EDGE = 8;
const GAP = 6;

/**
 * 목록 행의 "⋯" 메뉴. 행마다 버튼을 늘어놓지 않고 부가 동작(재배포 등)을 여기에 모은다.
 * 바깥을 누르거나 Esc를 누르면 닫힌다. 열리면 첫 항목으로 포커스가 가고, 닫히면 버튼으로 돌아온다.
 *
 * 목록은 body에 붙여 화면 기준(fixed)으로 띄운다. 카드마다 등장 애니메이션이 있어 카드가 각자 쌓임 맥락을 만들기 때문에,
 * 카드 안에 두면 z-index와 상관없이 다음 카드에 가려진다. 아래 공간이 모자라면 버튼 위로 연다.
 */
export function RowMenu({ label, items, onNavigate }: { /** 어느 배포의 메뉴인지 (화면 낭독기용) */ label: string; items: RowMenuItem[]; onNavigate: Navigate }) {
  const { t } = useI18n();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number; above: boolean } | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const list = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // 숨긴 채로 한 번 그려 높이를 잰 뒤 버튼 옆에 놓는다. 스크롤 · 창 크기 변경에도 버튼을 따라간다.
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return; }
    const place = () => {
      const button = trigger.current?.getBoundingClientRect();
      if (!button) return;
      const height = list.current?.offsetHeight ?? 0;
      const below = button.bottom + GAP;
      const above = below + height > window.innerHeight - EDGE && button.top - GAP - height >= EDGE;
      setPosition({ top: above ? button.top - GAP - height : below, right: Math.max(EDGE, window.innerWidth - button.right), above });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);

  const opened = open && position !== null;
  useEffect(() => {
    if (!opened) return;
    list.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true });
  }, [opened]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !list.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
      // 목록이 body 끝에 붙어 있어서, Tab은 버튼으로 돌아간 뒤 그다음 요소로 넘어가게 한다.
      if (event.key === 'Tab' && list.current?.contains(document.activeElement)) { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (items.length === 0) return null;
  const style: CSSProperties = position ? { top: position.top, right: position.right } : { top: 0, right: 0, visibility: 'hidden' };
  return <span className="row-menu" ref={root}>
    <button ref={trigger} type="button" className="row-menu__trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      aria-label={`${t.dashboard.more} — ${label}`} onClick={() => setOpen((current) => !current)}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
    </button>
    {open && createPortal(<span ref={list} id={menuId} className={`row-menu__list${position?.above ? ' is-above' : ''}`} role="menu" aria-label={label} style={style}>
      {items.map((item) => item.disabledReason
        ? <span key={item.key} className="row-menu__item is-disabled" role="menuitem" aria-disabled="true">
          {item.label}<span className="row-menu__reason">{item.disabledReason}</span>
        </span>
        : item.href
          ? <a key={item.key} className="row-menu__item" role="menuitem" href={item.href} onClick={(event) => { setOpen(false); followAppLink(event, onNavigate); }}>{item.label}</a>
          : <button key={item.key} type="button" className="row-menu__item" role="menuitem" onClick={() => { setOpen(false); item.onSelect?.(); }}>{item.label}</button>)}
    </span>, document.body)}
  </span>;
}
