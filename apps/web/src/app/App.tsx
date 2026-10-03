import { useEffect, useState } from 'react';
import { Sidebar } from '../components/layout/Sidebar';
import { AppHeader } from '../components/layout/AppHeader';
import { DeploymentProgress } from '../features/deployment-progress/DeploymentProgress';
import { DeploymentResult } from '../features/deployment-progress/DeploymentResult';
import { DashboardPage } from '../pages/DashboardPage';
import { ConnectionsPage } from '../pages/ConnectionsPage';
import { OpsPage } from '../pages/OpsPage';
import { ProjectDetailPage } from '../pages/ProjectDetailPage';
import { SimpleDeployPage } from '../pages/SimpleDeployPage';
import { DeploymentNotifier } from '../features/notifications/DeploymentNotifier';
import { DeployProjectProvider } from '../features/deployment-start/useDeployProject';
import { PreferencesProvider } from '../features/settings/preferences';
import { SoundProvider } from '../features/sound/SoundProvider';
import { I18nProvider } from '../i18n/I18nProvider';
import { ErrorBoundary } from './ErrorBoundary';
import { routeFromLocation, type Route } from './routes';

/** 다른 화면으로 옮겼는지 가르는 값. 같은 화면 안에서 탭만 바꾼 것은 같은 값이다 */
function routeKey(route: Route): string {
  return route.page === 'project' ? `project:${route.projectId}` : route.page === 'progress' || route.page === 'result' ? `${route.page}:${route.deploymentId}` : route.page;
}

export function App() {
  const [route, setRoute] = useState<Route>(routeFromLocation);

  useEffect(() => {
    const onPopState = () => setRoute(routeFromLocation());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  function navigate(path: string) {
    window.history.pushState(null, '', path);
    setRoute(routeFromLocation());
  }

  return <I18nProvider><SoundProvider><PreferencesProvider><DeployProjectProvider><div className="shell">
    <Sidebar activePage={route.page} onNavigate={navigate} />
    <div className="app-body"><AppHeader page={route.page} />
      <main className="content">
        <ErrorBoundary resetKey={routeKey(route)} onHome={() => navigate('/')}>
        {route.page === 'dashboard' && <DashboardPage onNavigate={navigate} />}
        {route.page === 'connections' && <ConnectionsPage />}
        {route.page === 'ops' && <OpsPage onNavigate={navigate} />}
        {route.page === 'project' && <ProjectDetailPage projectId={route.projectId} tab={route.tab} onNavigate={navigate} />}
        {route.page === 'deploy' && <SimpleDeployPage onNavigate={navigate} onStarted={(deploymentId) => navigate(`/deployments/${encodeURIComponent(deploymentId)}`)} />}
        {route.page === 'progress' && <DeploymentProgress key={route.deploymentId} deploymentId={route.deploymentId} tab={route.tab} onNavigate={navigate} onRedeployed={(id) => navigate(`/deployments/${encodeURIComponent(id)}`)} onSucceeded={() => navigate(`/deployments/${encodeURIComponent(route.deploymentId)}/result`)} onNewDeployment={() => navigate('/deploy')} onFixSettings={() => navigate('/connections')} />}
        {route.page === 'result' && <DeploymentResult deploymentId={route.deploymentId} onRedeployed={(id) => navigate(`/deployments/${encodeURIComponent(id)}`)} onBack={() => navigate(`/deployments/${encodeURIComponent(route.deploymentId)}`)} onNewDeployment={() => navigate('/deploy')} onOpenProject={(id) => navigate(`/projects/${encodeURIComponent(id)}`)} />}
        </ErrorBoundary>
      </main>
    </div>
    <DeploymentNotifier route={route} onNavigate={navigate} />
  </div></DeployProjectProvider></PreferencesProvider></SoundProvider></I18nProvider>;
}
