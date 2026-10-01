import { useEffect, useState } from 'react';
import { Sidebar } from '../components/layout/Sidebar';
import { AppHeader } from '../components/layout/AppHeader';
import { DeploymentProgress } from '../features/deployment-progress/DeploymentProgress';
import { DeploymentResult } from '../features/deployment-progress/DeploymentResult';
import { DashboardPage } from '../pages/DashboardPage';
import { ProjectDetailPage } from '../pages/ProjectDetailPage';
import { ProjectsPage } from '../pages/ProjectsPage';
import { SimpleDeployPage } from '../pages/SimpleDeployPage';
import { DeploymentNotifier } from '../features/notifications/DeploymentNotifier';
import { DeployProjectProvider } from '../features/deployment-start/useDeployProject';
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

  /** 뒤로 가기에 남기지 않고 화면을 바꾼다 (설정이 필요해서 자동으로 보낼 때). */
  function redirect(path: string) {
    window.history.replaceState(null, '', path);
    setRoute(routeFromLocation());
  }

  return <I18nProvider><SoundProvider><DeployProjectProvider><div className="shell">
    <Sidebar activePage={route.page} onNavigate={navigate} />
    <div className="app-body"><AppHeader page={route.page} />
      <main className="content">
        {route.page === 'dashboard' && <DashboardPage onNavigate={navigate} />}
        {route.page === 'projects' && <ProjectsPage onNavigate={navigate} />}
        {route.page === 'project' && <ProjectDetailPage projectId={route.projectId} tab={route.tab} onNavigate={navigate} />}
        {route.page === 'deploy' && <SimpleDeployPage onNavigate={navigate} onRedirect={redirect} onStarted={(deploymentId) => navigate(`/deployments/${encodeURIComponent(deploymentId)}`)} />}
        {route.page === 'progress' && <DeploymentProgress key={route.deploymentId} deploymentId={route.deploymentId} onSucceeded={() => navigate(`/deployments/${encodeURIComponent(route.deploymentId)}/result`)} onNewDeployment={() => navigate('/deploy')} onFixSettings={(projectId) => navigate(projectId ? `/projects/${encodeURIComponent(projectId)}/settings` : '/projects')} />}
        {route.page === 'result' && <DeploymentResult deploymentId={route.deploymentId} onBack={() => navigate(`/deployments/${encodeURIComponent(route.deploymentId)}`)} onNewDeployment={() => navigate('/deploy')} />}
      </main>
    </div>
    <DeploymentNotifier route={route} onNavigate={navigate} />
  </div></DeployProjectProvider></SoundProvider></I18nProvider>;
}
