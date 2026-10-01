import { useCallback, useEffect, useState } from 'react';
import { getDeploymentStatus, getProject, type DeploymentStatusResponse } from '../../api/deployment-api';
import { DeployKeycap } from '../../components/ui/DeployKeycap';
import { Keycap } from '../../components/ui/Keycap';
import { Koro, type KoroMood } from '../../components/ui/Koro';
import { StatusTape } from '../../components/ui/StatusTape';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { displayProjectName, elapsed, hostOf, safeHttpUrl } from '../dashboard/format';
import { deploymentStatusView } from '../deployment-status/status-view';

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }

/** targetProfile(aws-ecs-basic · onprem-docker-basic)에서 배포한 곳을 읽는다. 모르는 값은 그대로 보여 준다. */
function targetLabel(profile: string | null, labels: { aws: string; onprem: string }): string | null {
  if (!profile) return null;
  if (profile.startsWith('aws')) return labels.aws;
  if (profile.startsWith('onprem')) return labels.onprem;
  return profile;
}

/**
 * 배포 결과 화면. 성공하면 공개 주소를 가장 크게 보여 주고, 서버가 준 사실(배포한 곳 · 걸린 시간 · 완료 시각)만 덧붙인다.
 * 아직 진행 중이거나 실패한 배포는 진행 화면으로 돌려보낸다.
 */
export function DeploymentResult({ deploymentId, onBack, onNewDeployment }: { deploymentId: string; onBack: () => void; onNewDeployment: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<DeploymentStatusResponse | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getDeploymentStatus(deploymentId));
      setError(null);
    } catch (requestError) {
      setError(requestError);
    }
  }, [deploymentId]);
  useEffect(() => { void refresh(); }, [refresh]);

  const projectId = text(status?.projectId);
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    getProject(projectId).then((project) => { if (active) setProjectName(project.name); }, () => { /* 이름은 없어도 결과 화면은 동작한다 */ });
    return () => { active = false; };
  }, [projectId]);

  if (error !== null) return <section className="result-card is-unknown">
    <h1>{t.result.titleCheck}</h1>
    <div className="notice error" role="alert"><strong>{t.result.error}</strong><br />{errorMessage(error, t, t.errors.resultFailed)}</div>
    <div className="result-card__actions">
      <Keycap variant="secondary" onClick={() => void refresh()}>{t.progress.refresh}</Keycap>
      <Keycap variant="ghost" onClick={onBack}>{t.result.back}</Keycap>
    </div>
  </section>;

  if (!status) return <section className="result-card is-unknown"><h1>{t.result.titleCheck}</h1><p role="status">{t.result.loading}</p></section>;

  const view = deploymentStatusView(text(status.status) ?? 'received');
  const meta = <p className="result-card__meta">{projectName ? `${displayProjectName(projectName)} · ` : ''}{t.dashboard.deploymentNo(deploymentId)}</p>;

  if (view.outcome !== 'success') {
    const failed = view.outcome === 'failed';
    const mood: KoroMood = failed ? 'flustered' : view.outcome === 'active' ? 'normal' : 'sleepy';
    return <section className={`result-card is-${view.outcome}`} aria-labelledby="result-title">
      <Koro mood={mood} size={72} />
      <StatusTape tone={view.tone}>{view.tape}</StatusTape>
      <h1 id="result-title">{failed ? t.run.titleFailed : view.outcome === 'active' ? t.result.runningTitle : t.run.titleStopped}</h1>
      {meta}
      <p>{failed ? t.result.failedCopy : t.result.runningCopy}</p>
      <div className="result-card__actions">
        <Keycap onClick={onBack}>{t.result.back}</Keycap>
        <Keycap variant="secondary" onClick={() => void refresh()}>{t.progress.refresh}</Keycap>
      </div>
    </section>;
  }

  const targetUrl = safeHttpUrl(text(status.publicUrl));
  const createdAt = text(status.createdAt);
  const succeededAt = text(status.succeededAt);
  const target = targetLabel(text(status.targetProfile), t.result.targets);
  async function copyUrl() {
    if (!targetUrl) return;
    try { await navigator.clipboard.writeText(targetUrl); setCopied(true); } catch { setCopied(false); }
  }

  return <section className="result-card is-success" aria-labelledby="result-title">
    <Koro mood="happy" size={72} />
    <StatusTape tone="success">{view.tape}</StatusTape>
    <h1 id="result-title">{t.result.titleDone}</h1>
    {meta}

    {targetUrl
      ? <div className="result-url">
        <a className="result-url__link" href={targetUrl} target="_blank" rel="noreferrer">{hostOf(targetUrl)}<span className="visually-hidden"> {t.dashboard.newTab}</span></a>
        <div className="result-url__actions">
          <Keycap href={targetUrl} target="_blank" rel="noreferrer">{t.progress.openApp}</Keycap>
          <Keycap variant="secondary" onClick={() => void copyUrl()}>{copied ? t.setup.copied : t.result.copyUrl}</Keycap>
        </div>
      </div>
      : <p className="result-card__note">{t.result.urlPending}</p>}

    <dl className="result-facts">
      {target && <div><dt>{t.result.factTarget}</dt><dd>{target}</dd></div>}
      {createdAt && succeededAt && <div><dt>{t.result.factDuration}</dt><dd>{elapsed(createdAt, Date.parse(succeededAt))}</dd></div>}
      {succeededAt && <div><dt>{t.result.factFinished}</dt><dd>{new Date(succeededAt).toLocaleString(t.locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</dd></div>}
    </dl>

    <div className="result-card__actions">
      <DeployKeycap onClick={onNewDeployment}>{t.result.newDeploy}</DeployKeycap>
      <Keycap variant="ghost" onClick={onBack}>{t.result.back}</Keycap>
    </div>
  </section>;
}
