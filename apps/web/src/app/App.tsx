import { useEffect, useState } from 'react';
import { Sidebar } from '../components/layout/Sidebar';
import { AppHeader } from '../components/layout/AppHeader';
import { DeploymentProgress } from '../features/deployment-progress/DeploymentProgress';
import { DeploymentResult } from '../features/deployment-progress/DeploymentResult';
import { DashboardPage } from '../pages/DashboardPage';
import { ConnectionsPage } from '../pages/ConnectionsPage';
import { ProjectDetailPage } from '../pages/ProjectDetailPage';
import { SimpleDeployPage } from '../pages/SimpleDeployPage';
import { DeploymentNotifier } from '../features/notifications/DeploymentNotifier';
import { DeployProjectProvider } from '../features/deployment-start/useDeployProject';
import { PreferencesProvider } from '../features/settings/preferences';
import { SoundProvider } from '../features/sound/SoundProvider';
import { I18nProvider } from '../i18n/I18nProvider';
import { routeFromLocation, type Route } from './routes';

const SIDEBAR_KEY = 'camellia.sidebar';
function readSidebarPinned(): boolean {
  try { return window.localStorage.getItem(SIDEBAR_KEY) !== 'collapsed'; } catch { return true; }
}

export function App() {
  const [route, setRoute] = useState<Route>(routeFromLocation);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // 왼쪽 바: 접어 두면 아이콘만 남고, 마우스를 올리거나 키보드로 들어가면 잠깐 펼쳐진다. 선택은 이 브라우저에 기억한다.
  // 배포 진행 화면은 장면에 집중하도록 들어갈 때 접어 둔다(그 화면 안에서 펼치면 그 화면에 있는 동안만 유지한다).
  const [sidebarPinned, setSidebarPinned] = useState(readSidebarPinned);
  const [openOnProgress, setOpenOnProgress] = useState(false);
  const onProgress = route.page === 'progress';
  useEffect(() => { if (!onProgress) setOpenOnProgress(false); }, [onProgress]);
  const sidebarCollapsed = onProgress ? !openOnProgress : !sidebarPinned;
  function toggleSidebar() {
    if (onProgress) { setOpenOnProgress((open) => !open); return; }
    setSidebarPinned((pinned) => {
      try { window.localStorage.setItem(SIDEBAR_KEY, pinned ? 'collapsed' : 'pinned'); } catch { /* 저장하지 못하면 이번 방문에만 적용 */ }
      return !pinned;
    });
  }

  function navigate(path: string) {
    window.history.pushState(null, '', path);
    setRoute(routeFromLocation());
  }

  return <I18nProvider><SoundProvider><PreferencesProvider><DeployProjectProvider><div className={`shell ${sidebarCollapsed ? 'is-collapsed' : ''}`}>
    <Sidebar activePage={route.page} onNavigate={navigate} collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
    <div className="app-body"><AppHeader page={route.page} />
      <main className="content">
        {route.page === 'dashboard' && <DashboardPage onNavigate={navigate} />}
        {route.page === 'connections' && <ConnectionsPage />}
        {route.page === 'project' && <ProjectDetailPage projectId={route.projectId} tab={route.tab} onNavigate={navigate} />}
        {route.page === 'deploy' && <SimpleDeployPage onNavigate={navigate} onStarted={(deploymentId) => navigate(`/deployments/${encodeURIComponent(deploymentId)}`)} />}
        {route.page === 'progress' && <DeploymentProgress key={route.deploymentId} deploymentId={route.deploymentId} tab={route.tab} onNavigate={navigate} onRedeployed={(id) => navigate(`/deployments/${encodeURIComponent(id)}`)} onSucceeded={() => navigate(`/deployments/${encodeURIComponent(route.deploymentId)}/result`)} onNewDeployment={() => navigate('/deploy')} onFixSettings={() => navigate('/connections')} />}
        {route.page === 'result' && <DeploymentResult deploymentId={route.deploymentId} onRedeployed={(id) => navigate(`/deployments/${encodeURIComponent(id)}`)} onBack={() => navigate(`/deployments/${encodeURIComponent(route.deploymentId)}`)} onNewDeployment={() => navigate('/deploy')} />}
      </main>
    </div>
    <DeploymentNotifier route={route} onNavigate={navigate} />
  </div></DeployProjectProvider></PreferencesProvider></SoundProvider></I18nProvider>;
}
