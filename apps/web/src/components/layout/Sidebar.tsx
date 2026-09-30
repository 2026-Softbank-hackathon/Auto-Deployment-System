import type { Route } from '../../app/routes';
import { followAppLink, type Navigate } from '../../app/navigation';
import { useI18n } from '../../i18n/I18nProvider';
import { Marble } from '../ui/Marble';
import { Rail } from '../ui/Rail';

interface SidebarProps {
  activePage: Route['page'];
  onNavigate: Navigate;
}

const menu = [
  { path: '/', label: 'dashboard', pages: ['dashboard'] },
  { path: '/deploy', label: 'deploy', pages: ['deploy', 'progress', 'result'] },
] as const satisfies ReadonlyArray<{ path: string; label: 'dashboard' | 'deploy'; pages: ReadonlyArray<Route['page']> }>;

function BrandMark() {
  return <svg className="brand-mark" width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
    <rect className="brand-mark__base" x="1" y="4" width="34" height="31" rx="9" />
    <rect className="brand-mark__cap" x="1" y="1" width="34" height="30" rx="9" />
    <circle className="brand-mark__marble" cx="24" cy="21" r="6" />
    <circle className="brand-mark__shine" cx="22" cy="19" r="1.8" />
  </svg>;
}

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const { t } = useI18n();
  return <aside className="sidebar">
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
            {t.nav[item.label]}
          </a>;
        })}
      </Rail>
    </nav>
  </aside>;
}
