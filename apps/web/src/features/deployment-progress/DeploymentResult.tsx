import { useCallback, useEffect, useState } from 'react';
import { getDeploymentStatus, type DeploymentStatusResponse } from '../../api/deployment-api';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { hostOf, safeHttpUrl } from '../dashboard/format';

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null; }

export function DeploymentResult({ deploymentId, onBack, onNewDeployment }: { deploymentId: string; onBack: () => void; onNewDeployment: () => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<DeploymentStatusResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getDeploymentStatus(deploymentId));
      setError(null);
    } catch (requestError) {
      setError(requestError);
    }
  }, [deploymentId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const succeeded = text(status?.status) === 'succeeded';
  const targetUrl = safeHttpUrl(text(status?.publicUrl));
  return <>
    <div className="page-head"><div><h1>{succeeded ? t.result.titleDone : t.result.titleCheck}</h1><p>{t.progress.deploymentId}: <code>{deploymentId}</code></p></div><span className={`chip ${succeeded ? 'result-success' : ''}`}>{succeeded ? 'SUCCEEDED' : t.result.checking}</span></div>
    <section className={`panel result-panel ${succeeded ? 'success' : ''}`}>
      {error !== null ? <div className="notice error"><strong>{t.result.error}</strong><br />{errorMessage(error, t, t.errors.resultFailed)}</div> : succeeded ? <><h2>{targetUrl ? t.result.openTitle : t.result.noUrlTitle}</h2>{targetUrl && <p><code>{hostOf(targetUrl)}</code></p>}{targetUrl && <a className="primary open-url" href={targetUrl} target="_blank" rel="noreferrer">{t.progress.openApp}</a>}{!targetUrl && <p>{t.result.urlPending}</p>}</> : <><h2>{t.result.runningTitle}</h2><p>{t.result.runningCopy}</p></>}
      <div className="page-actions"><button className="secondary" onClick={onBack}>{t.result.back}</button><button className="secondary" onClick={() => void refresh()}>{t.progress.refresh}</button>{succeeded && <button className="primary" onClick={onNewDeployment}>{t.result.newDeploy}</button>}</div>
    </section>
  </>;
}
