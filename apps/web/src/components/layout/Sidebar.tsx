import { useEffect } from 'react';
import type { Route } from '../../app/routes';
import { followAppLink, type Navigate } from '../../app/navigation';
import { useI18n } from '../../i18n/I18nProvider';
import { Marble } from '../ui/Marble';
import { Rail } from '../ui/Rail';
import brandMark from '../../assets/brand-mark.png';

interface SidebarProps {
  activePage: Route['page'];
  onNavigate: Navigate;
}

const menu = [
  { path: '/', label: 'dashboard', pages: ['dashboard', 'project'] },
  { path: '/deploy', label: 'deploy', pages: ['deploy', 'progress', 'result'] },
  { path: '/connections', label: 'connections', pages: ['connections'] },
  { path: '/ops', label: 'ops', pages: ['ops'] },
] as const satisfies ReadonlyArray<{ path: string; label: 'dashboard' | 'deploy' | 'connections' | 'ops'; pages: ReadonlyArray<Route['page']> }>;

/** 서비스 로고 (코로). 이름 옆 장식이라 화면 낭독기에는 읽히지 않게 한다 — 링크의 이름은 aria-label 이 준다 */
function BrandMark() {
  return <img className="brand-mark" src={brandMark} width="36" height="36" alt="" />;
}

export function Sidebar({ activePage, onNavigate }: SidebarProps) {
  const { t } = useI18n();
  // 브라우저 탭 제목도 화면 언어의 서비스 이름을 따른다
  useEffect(() => { document.title = t.brand.name; }, [t.brand.name]);
  return <aside className="sidebar">
    <div className="sidebar__brand">
      <a href="/" className="sidebar__brand-row" aria-label={t.nav.dashboard} onClick={(event) => followAppLink(event, onNavigate)}>
        <BrandMark />
        <span className="sidebar__name">{t.brand.name}</span>
      </a>
      {/* 서비스 이름이 길어져서(코로의 이사 · コロの引越し) 버전 표시는 이름 옆이 아니라 아래 줄에 둔다 */}
      <span className="sidebar__tagline">One Action, Infinite Clouds <span className="sidebar__version">v0.4.0</span></span>
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
