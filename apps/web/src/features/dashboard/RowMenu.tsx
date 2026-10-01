import { useEffect, useId, useRef, useState } from 'react';
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

/**
 * 목록 행의 "⋯" 메뉴. 행마다 버튼을 늘어놓지 않고 부가 동작(재배포 등)을 여기에 모은다.
 * 바깥을 누르거나 Esc를 누르면 닫힌다. 열리면 첫 항목으로 포커스가 가고, 닫히면 버튼으로 돌아온다.
 */
export function RowMenu({ label, items, onNavigate }: { /** 어느 배포의 메뉴인지 (화면 낭독기용) */ label: string; items: RowMenuItem[]; onNavigate: Navigate }) {
  const { t } = useI18n();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus();
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); };
  }, [open]);

  if (items.length === 0) return null;
  return <span className="row-menu" ref={root}>
    <button ref={trigger} type="button" className="row-menu__trigger" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
      aria-label={`${t.dashboard.more} — ${label}`} onClick={() => setOpen((current) => !current)}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></svg>
    </button>
    {open && <span id={menuId} className="row-menu__list" role="menu" aria-label={label}>
      {items.map((item) => item.disabledReason
        ? <span key={item.key} className="row-menu__item is-disabled" role="menuitem" aria-disabled="true">
          {item.label}<span className="row-menu__reason">{item.disabledReason}</span>
        </span>
        : item.href
          ? <a key={item.key} className="row-menu__item" role="menuitem" href={item.href} onClick={(event) => { setOpen(false); followAppLink(event, onNavigate); }}>{item.label}</a>
          : <button key={item.key} type="button" className="row-menu__item" role="menuitem" onClick={() => { setOpen(false); item.onSelect?.(); }}>{item.label}</button>)}
    </span>}
  </span>;
}
