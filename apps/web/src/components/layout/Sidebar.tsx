import type { Route } from '../../app/routes';
import { followAppLink, type Navigate } from '../../app/navigation';
import { setupStatus, useDeployProject } from '../../features/deployment-start/useDeployProject';
import { useI18n } from '../../i18n/I18nProvider';
import { Marble } from '../ui/Marble';
import { Rail } from '../ui/Rail';

interface SidebarProps {
  activePage: Route['page'];
  onNavigate: Navigate;
}

const menu = [
  { path: '/', label: 'dashboard', pages: ['dashboard'] },
  { path: '/projects', label: 'projects', pages: ['projects'] },
  { path: '/deploy', label: 'deploy', pages: ['deploy', 'progress', 'result'] },
] as const satisfies ReadonlyArray<{ path: string; label: 'dashboard' | 'projects' | 'deploy'; pages: ReadonlyArray<Route['page']> }>;

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
  const status = setupStatus(useDeployProject().state);
  const setupNeeded = status.ready && !status.awsReady;
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
    <a href="/setup" className="sidebar__setup" aria-current={activePage === 'setup' ? 'page' : undefined} onClick={(event) => followAppLink(event, onNavigate)}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M9 7 H5 a4 4 0 0 0 0 8 H9" /><path d="M15 7 H19 a4 4 0 0 1 0 8 H15" /><path d="M8 11 H16" />
      </svg>
      {t.nav.setup}
      {setupNeeded && <><span className="sidebar__setup-dot" aria-hidden="true" /><span className="visually-hidden"> {t.nav.setupNeeded}</span></>}
    </a>
  </aside>;
}
