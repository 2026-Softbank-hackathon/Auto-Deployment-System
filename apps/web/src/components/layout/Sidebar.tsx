import { useEffect, useState } from 'react';
import type { Route } from '../../app/routes';
import { followAppLink, type Navigate } from '../../app/navigation';
import { useI18n } from '../../i18n/I18nProvider';
import { Marble } from '../ui/Marble';
import { Rail } from '../ui/Rail';

interface SidebarProps {
  activePage: Route['page'];
  onNavigate: Navigate;
  /** 접힌 상태 — 아이콘만 보이고, 마우스를 올리거나 키보드로 들어오면 잠깐 펼쳐진다 */
  collapsed: boolean;
  onToggle: () => void;
}

const menu = [
  { path: '/', label: 'dashboard', pages: ['dashboard', 'project'] },
  { path: '/deploy', label: 'deploy', pages: ['deploy', 'progress', 'result'] },
  { path: '/connections', label: 'connections', pages: ['connections'] },
] as const satisfies ReadonlyArray<{ path: string; label: 'dashboard' | 'deploy' | 'connections'; pages: ReadonlyArray<Route['page']> }>;

function BrandMark() {
  return <svg className="brand-mark" width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
    <rect className="brand-mark__base" x="1" y="4" width="34" height="31" rx="9" />
    <rect className="brand-mark__cap" x="1" y="1" width="34" height="30" rx="9" />
    <circle className="brand-mark__marble" cx="24" cy="21" r="6" />
    <circle className="brand-mark__shine" cx="22" cy="19" r="1.8" />
  </svg>;
}

export function Sidebar({ activePage, onNavigate, collapsed, onToggle }: SidebarProps) {
  const { t } = useI18n();
  // 접힌 바는 마우스를 올리면 잠깐 펼쳐진다. 그런데 방금 접은 순간에는 마우스가 아직 바 위에 있어서, 그대로 두면 접히지 않은 것처럼 보인다.
  // 그래서 접힌 직후에는 마우스가 한 번 바를 벗어날 때까지 펼치지 않는다. (키보드로 들어온 포커스는 CSS 가 :focus-visible 로 따로 다룬다.)
  const [peekReady, setPeekReady] = useState(!collapsed);
  useEffect(() => { setPeekReady(!collapsed); }, [collapsed]);
  return <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''} ${collapsed && peekReady ? 'can-peek' : ''}`} onMouseLeave={() => setPeekReady(true)}>
    <div className="sidebar__brand">
      <div className="sidebar__brand-row">
        <BrandMark />
        <span className="sidebar__name">camellia</span>
        <span className="sidebar__version">v0.4.0</span>
      </div>
      <span className="sidebar__tagline">One Action, Infinite Clouds</span>
    </div>
    <nav aria-label={t.nav.label}>
      <Rail orientation="vertical" className="sidebar__rail">
        {menu.map((item) => {
          const active = (item.pages as ReadonlyArray<Route['page']>).includes(activePage);
          return <a key={item.path} href={item.path} className="sidebar__link" aria-current={active ? 'page' : undefined}
            onClick={(event) => followAppLink(event, onNavigate)}>
            <span className="sidebar__stop" aria-hidden="true">{active ? <Marble tone="running" /> : <span className="sidebar__dot" />}</span>
            <span className="sidebar__label">{t.nav[item.label]}</span>
          </a>;
        })}
      </Rail>
    </nav>
    {/* 접기 · 펼치기 — 바 맨 아래. 접힌 상태에서도 아이콘이 보여서 바로 펼칠 수 있다 */}
    <button type="button" className="sidebar__toggle" onClick={onToggle} aria-pressed={!collapsed} aria-label={collapsed ? t.nav.pin : t.nav.collapse} title={collapsed ? t.nav.pin : t.nav.collapse}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect x="2" y="3" width="14" height="12" rx="2.5" /><path d="M7 3 V15" />{collapsed ? <path d="M10 7 L12.5 9 L10 11" /> : <path d="M12.5 7 L10 9 L12.5 11" />}</svg>
      <span className="sidebar__label">{collapsed ? t.nav.pin : t.nav.collapse}</span>
    </button>
  </aside>;
}
