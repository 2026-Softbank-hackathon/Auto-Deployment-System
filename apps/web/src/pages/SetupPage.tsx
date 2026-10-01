import { useEffect, useId, useState, type ReactNode } from 'react';
import { followAppLink, type Navigate } from '../app/navigation';
import { DeployKeycap } from '../components/ui/DeployKeycap';
import { Keycap } from '../components/ui/Keycap';
import { StatusTape } from '../components/ui/StatusTape';
import type { MarbleTone } from '../components/ui/Marble';
import { displayProjectName } from '../features/dashboard/format';
import { AwsKeyForm } from '../features/deployment-start/AwsKeyForm';
import { setupStatus, useDeployProject } from '../features/deployment-start/useDeployProject';
import { EnvVarsCard } from '../features/setup/EnvVarsCard';
import { OnpremCard } from '../features/setup/OnpremCard';
import { ProjectNameForm } from '../features/projects/ProjectNameForm';
import { errorMessage, useI18n } from '../i18n/I18nProvider';

function Card({ id, title, tone, status, children }: { id?: string; title: string; tone: MarbleTone; status: string; children: ReactNode }) {
  const titleId = useId();
  return <section id={id} className="setup-card" aria-labelledby={titleId}>
    <div className="setup-card__head">
      <h2 id={titleId}>{title}</h2>
      <StatusTape tone={tone}>{status}</StatusTape>
    </div>
    <div className="setup-card__body">{children}</div>
  </section>;
}

/**
 * 연결 설정: 지금 고른 프로젝트의 AWS 키 · 온프레미스 서버 · 환경변수를 등록하고 바꾼다.
 * 프로젝트 목록과 새 프로젝트 추가는 내 프로젝트(/projects)에서 한다.
 * 처음 한 번만 하면 되고, 그다음부터 간단 배포에서는 ZIP만 올리면 된다.
 */
export function SetupPage({ onNavigate }: { onNavigate: Navigate }) {
  const { t } = useI18n();
  const { state, refresh, createDeployProject, registerAws, registerOnprem } = useDeployProject();
  const [changingKey, setChangingKey] = useState(false);
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

  const { project, aws, onprem, keysMissing, awsReady } = status;
  const awsTone: MarbleTone = awsReady ? 'success' : keysMissing ? 'failed' : 'waiting';
  const awsStatus = awsReady ? t.setup.status.done : keysMissing ? t.setup.status.fix : t.setup.status.needed;
  const showKeyForm = project !== null && (!aws || keysMissing || changingKey);

  return <>
    <div className="page-head">
      <div><h1>{t.setup.title}</h1><p>{t.setup.description}</p></div>
      {awsReady && <DeployKeycap href="/deploy" onClick={(event) => followAppLink(event, onNavigate)}>{t.setup.goDeploy}</DeployKeycap>}
    </div>

    <Card title={t.setup.app.title} tone={project ? 'success' : 'waiting'} status={project ? t.setup.status.done : t.setup.status.needed}>
      {project
        ? <>
          <p className="setup-card__value">{displayProjectName(project.name)}</p>
          <p>{t.setup.app.doneCopy}</p>
          <div><a className="setup-summary__link" href="/projects" onClick={(event) => followAppLink(event, onNavigate)}>{t.nav.projects}</a></div>
        </>
        : <><p>{t.setup.app.copy}</p><ProjectNameForm onCreate={createDeployProject} /></>}
    </Card>

    <Card title={t.setup.aws.title} tone={awsTone} status={awsStatus}>
      {!project && <p>{t.setup.needsApp}</p>}
      {project && aws && !keysMissing && <p className="setup-card__value">{aws.region ?? aws.name}</p>}
      {project && keysMissing && <p className="setup-card__alert">{t.setup.aws.keysMissing}</p>}
      {project && !showKeyForm && <>
        <p>{t.setup.aws.doneCopy}</p>
        <div><Keycap variant="secondary" onClick={() => setChangingKey(true)}>{t.setup.aws.change}</Keycap></div>
      </>}
      {showKeyForm && <>
        <p>{aws && !keysMissing ? t.setup.aws.changeCopy : t.setup.aws.copy}</p>
        <AwsKeyForm key={project?.id} initialRegion={aws?.region} onCancel={changingKey ? () => setChangingKey(false) : undefined}
          onSubmit={async (input) => { await registerAws(input); setChangingKey(false); }} />
      </>}
    </Card>

    <Card id="onprem" title={t.setup.onprem.title} tone={onprem ? 'success' : 'waiting'} status={onprem ? t.setup.status.registered : t.setup.status.optional}>
      <OnpremCard key={project?.id} hasProject={project !== null} environment={onprem} onRegisterHost={registerOnprem} />
    </Card>

    <Card title={t.setup.env.title} tone="waiting" status={t.setup.status.optional}>
      <EnvVarsCard projectId={project?.id ?? null} />
    </Card>
  </>;
}
