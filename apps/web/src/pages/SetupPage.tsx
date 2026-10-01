import { useEffect } from 'react';
import { followAppLink, type Navigate } from '../app/navigation';
import { DeployKeycap } from '../components/ui/DeployKeycap';
import { Keycap } from '../components/ui/Keycap';
import { displayProjectName } from '../features/dashboard/format';
import { setupStatus, useDeployProject } from '../features/deployment-start/useDeployProject';
import { ConnectionCards, SetupCard } from '../features/setup/ConnectionCards';
import { ProjectNameForm } from '../features/projects/ProjectNameForm';
import { errorMessage, useI18n } from '../i18n/I18nProvider';

/**
 * 연결 설정: 지금 고른 프로젝트의 AWS 키 · 온프레미스 서버를 등록하고 바꾼다. 환경변수와 배포 내역은 프로젝트 상세에서 본다.
 * 프로젝트 목록과 새 프로젝트 추가는 내 프로젝트(/projects)에서 한다.
 * 처음 한 번만 하면 되고, 그다음부터 간단 배포에서는 ZIP만 올리면 된다.
 */
export function SetupPage({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useI18n();
  const { state, refresh, createDeployProject } = useDeployProject();
  const status = setupStatus(state);
  // 화면에 들어올 때 연결 상태를 다시 읽는다.
  useEffect(() => { void refresh(); }, [refresh]);

  if (state.phase === 'loading' || !status.ready) {
    return <>
      <div className="page-head"><div><h1>{t.setup.title}</h1><p>{t.setup.description}</p></div></div>
      {state.phase === 'error'
        ? <div className="notice error" role="alert"><strong>{t.setup.loadError}</strong><br />{errorMessage(state.error, t, t.setup.loadError)}
          <div className="page-actions"><Keycap variant="secondary" onClick={() => void refresh()}>{t.dashboard.retry}</Keycap></div></div>
        : <p className="dashboard-status" role="status">{t.setup.loading}</p>}
    </>;
  }

  const { project, awsReady } = status;

  return <>
    <div className="page-head">
      <div><h1>{t.setup.title}</h1><p>{t.setup.description}</p></div>
      {awsReady && <DeployKeycap href="/deploy" onClick={(event) => followAppLink(event, onNavigate)}>{t.setup.goDeploy}</DeployKeycap>}
    </div>

    <SetupCard title={t.setup.app.title} tone={project ? 'success' : 'waiting'} status={project ? t.setup.status.done : t.setup.status.needed}>
      {project
        ? <>
          <p className="setup-card__value">{displayProjectName(project.name)}</p>
          <p>{t.setup.app.doneCopy}</p>
          <div><a className="setup-summary__link" href={`/projects/${encodeURIComponent(project.id)}`} onClick={(event) => followAppLink(event, onNavigate)}>{t.projects.openDetail}</a></div>
        </>
        : <><p>{t.setup.app.copy}</p><ProjectNameForm onCreate={createDeployProject} /></>}
    </SetupCard>

    <ConnectionCards />
  </>;
}
