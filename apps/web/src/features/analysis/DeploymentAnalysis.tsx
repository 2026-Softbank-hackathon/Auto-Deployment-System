import { useEffect, useState } from 'react';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { DeploymentApiError, getDeploymentAnalysisReport, getDeploymentIr, type DeploymentAnalysisReportResponse, type DeploymentIrResponse } from '../../api/deployment-api';

function count(value: unknown): number { return Array.isArray(value) ? value.length : 0; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
function printable(value: unknown): string { return JSON.stringify(value, null, 2); }

export function DeploymentAnalysis({ deploymentId, deploymentStatus }: { deploymentId: string; deploymentStatus: string | null }) {
  const { t } = useI18n();
  const [report, setReport] = useState<DeploymentAnalysisReportResponse | null>(null);
  const [ir, setIr] = useState<DeploymentIrResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      const [reportResult, irResult] = await Promise.allSettled([
        getDeploymentAnalysisReport(deploymentId),
        getDeploymentIr(deploymentId),
      ]);
      if (!active) return;
      if (reportResult.status === 'fulfilled') setReport(reportResult.value);
      if (irResult.status === 'fulfilled') setIr(irResult.value);
      const failure = [reportResult, irResult].find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected' && !(failure.reason instanceof DeploymentApiError && failure.reason.status === 404)) {
        setError(failure.reason);
      }
    }
    void load();
    return () => { active = false; };
  }, [deploymentId, deploymentStatus]);

  const stack = strings(report?.detectedStack);
  return <section className="panel analysis-panel">
    <div className="panel-title"><div><h2>{t.analysis.title}</h2><p>{t.analysis.description}</p></div><span className="chip">{report ? t.analysis.done : t.analysis.running}</span></div>
    {error !== null && <div className="notice error"><strong>{t.analysis.error}</strong><br />{errorMessage(error, t, t.errors.analysisFailed)}</div>}
    {!report && error === null && <p>{t.analysis.pending}</p>}
    {report && <><div className="summary-grid"><div><small>{t.analysis.stack}</small><strong>{stack.length ? stack.join(', ') : t.analysis.checking}</strong></div><div><small>{t.analysis.services}</small><strong>{t.analysis.count(count(report.services))}</strong></div><div><small>{t.analysis.resources}</small><strong>{t.analysis.count(count(report.resources))}</strong></div><div><small>{t.analysis.warnings}</small><strong>{t.analysis.cases(count(report.warnings))}</strong></div></div>{count(report.warnings) > 0 && <div className="notice"><strong>{t.analysis.riskTitle}</strong><br />{t.analysis.riskCopy}</div>}{count(report.unresolved) > 0 && <p className="muted-copy">{t.analysis.unresolved(count(report.unresolved))}</p>}</>}
    <details className="technical-details"><summary>{t.analysis.irToggle}</summary>{ir ? <pre>{printable(ir.ir)}</pre> : <p>{t.analysis.irPending}</p>}</details>
  </section>;
}
