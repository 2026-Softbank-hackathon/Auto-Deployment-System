import { useEffect, useState } from 'react';
import { Sidebar } from '../components/layout/Sidebar';
import { AppHeader } from '../components/layout/AppHeader';
import { DeploymentProgress } from '../features/deployment-progress/DeploymentProgress';
import { DeploymentResult } from '../features/deployment-progress/DeploymentResult';
import { DashboardPage } from '../pages/DashboardPage';
import { SimpleDeployPage } from '../pages/SimpleDeployPage';
import { SoundProvider } from '../features/sound/SoundProvider';
import { I18nProvider } from '../i18n/I18nProvider';
import { routeFromLocation, type Route } from './routes';

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

  return <I18nProvider><SoundProvider><div className="shell">
    <Sidebar activePage={route.page} onNavigate={navigate} />
    <div className="app-body"><AppHeader page={route.page} />
      <main className="content">
        {route.page === 'dashboard' && <DashboardPage onNavigate={navigate} />}
        {route.page === 'deploy' && <SimpleDeployPage onNavigate={navigate} onStarted={(deploymentId) => navigate(`/deployments/${encodeURIComponent(deploymentId)}`)} />}
        {route.page === 'progress' && <DeploymentProgress key={route.deploymentId} deploymentId={route.deploymentId} onSucceeded={() => navigate(`/deployments/${encodeURIComponent(route.deploymentId)}/result`)} onNewDeployment={() => navigate('/deploy')} />}
        {route.page === 'result' && <DeploymentResult deploymentId={route.deploymentId} onBack={() => navigate(`/deployments/${encodeURIComponent(route.deploymentId)}`)} onNewDeployment={() => navigate('/deploy')} />}
      </main>
    </div>
  </div></SoundProvider></I18nProvider>;
}
