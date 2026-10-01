import { useId, useState, type ReactNode } from 'react';
import { StatusTape } from '../../components/ui/StatusTape';
import type { MarbleTone } from '../../components/ui/Marble';
import { Keycap } from '../../components/ui/Keycap';
import { useI18n } from '../../i18n/I18nProvider';
import { AwsKeyForm } from '../deployment-start/AwsKeyForm';
import { setupStatus, useDeployProject } from '../deployment-start/useDeployProject';
import { OnpremCard } from './OnpremCard';

export function SetupCard({ id, title, tone, status, children }: { id?: string; title: string; tone: MarbleTone; status: string; children: ReactNode }) {
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
 * 지금 고른 프로젝트의 연결 카드 두 장: AWS 연결(키 · 리전), 온프레미스 연결(서버 · Agent).
 * 프로젝트 상세의 설정 탭에서 쓴다.
 */
export function ConnectionCards() {
  const { t } = useI18n();
  const { state, refresh, registerAws, registerOnprem, removeEnvironment } = useDeployProject();
  const [changingKey, setChangingKey] = useState(false);
  const status = setupStatus(state);
  if (!status.ready) return null;

  const { project, aws, onprem, keysMissing, awsReady } = status;
  const awsTone: MarbleTone = awsReady ? 'success' : keysMissing ? 'failed' : 'waiting';
  const awsStatus = awsReady ? t.setup.status.done : keysMissing ? t.setup.status.fix : t.setup.status.needed;
  const showKeyForm = project !== null && (!aws || keysMissing || changingKey);

  return <>
    <SetupCard title={t.setup.aws.title} tone={awsTone} status={awsStatus}>
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
    </SetupCard>

    <SetupCard id="onprem" title={t.setup.onprem.title} tone={onprem ? 'success' : 'waiting'} status={onprem ? t.setup.status.registered : t.setup.status.optional}>
      <OnpremCard key={project?.id} hasProject={project !== null} environment={onprem} onRegisterHost={registerOnprem} onRemoveHost={removeEnvironment} onRefresh={refresh} />
    </SetupCard>
  </>;
}
