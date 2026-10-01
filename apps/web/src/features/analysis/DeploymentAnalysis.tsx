import { useEffect, useState } from 'react';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { DeploymentApiError, getDeploymentAiUsage, getDeploymentAnalysisReport, getDeploymentIr, type DeploymentAiUsageResponse, type DeploymentAnalysisReportResponse, type DeploymentIrResponse } from '../../api/deployment-api';

function count(value: unknown): number { return Array.isArray(value) ? value.length : 0; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
/** 분석 경고 한 건 (packages/analyzer Warning: code · message · path). 문구는 서버가 준 그대로 보여 준다. */
interface AnalysisWarning { code: string; message: string; path: string | null }
function warningsOf(value: unknown): AnalysisWarning[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AnalysisWarning[] => {
    if (!item || typeof item !== 'object') return [];
    const { code, message, path } = item as { code?: unknown; message?: unknown; path?: unknown };
    if (typeof message !== 'string') return [];
    return [{ code: typeof code === 'string' ? code : '', message, path: typeof path === 'string' ? path : null }];
  });
}
/** 분석이 찾은 서비스 한 개 (packages/analyzer Service). 없는 값은 화면에서 "감지되지 않음"으로 둔다. */
interface AnalysisService { name: string; stack: string; port: number | null; command: string | null; path: string | null; envNames: string[] }
function servicesOf(value: unknown): AnalysisService[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AnalysisService[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string') return [];
    const command = Array.isArray(record.command) ? strings(record.command).join(' ') : typeof record.command === 'string' ? record.command : '';
    return [{
      name: record.name,
      stack: [record.language, record.framework].filter((part): part is string => typeof part === 'string' && part !== '' && part !== 'unknown').join(' · '),
      port: typeof record.port === 'number' ? record.port : null,
      command: command || null,
      path: typeof record.path === 'string' ? record.path : null,
      envNames: strings(record.env_names),
    }];
  });
}
/** 분석이 찾은 의존 리소스 (DB · 캐시 등). */
function resourcesOf(value: unknown): Array<{ name: string; type: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return typeof record.name === 'string' && typeof record.type === 'string' ? [{ name: record.name, type: record.type }] : [];
  });
}
/** 사람이 읽을 수 있는 한 줄로. 모양이 정해지지 않은 항목(IR 검증 오류 · 미결 항목)에 쓴다. */
function lineOf(item: unknown): string {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    const where = Array.isArray(record.path) ? record.path.join('.') : typeof record.path === 'string' ? record.path : '';
    const what = typeof record.message === 'string' ? record.message : typeof record.reason === 'string' ? record.reason : '';
    if (where || what) return [where, what].filter(Boolean).join(' — ');
  }
  return JSON.stringify(item);
}
function printable(value: unknown): string { return JSON.stringify(value, null, 2); }

const finishedStatuses = ['succeeded', 'failed', 'cancelled', 'rejected'];

export function DeploymentAnalysis({ deploymentId, deploymentStatus }: { deploymentId: string; deploymentStatus: string | null }) {
  const { t } = useI18n();
  const [report, setReport] = useState<DeploymentAnalysisReportResponse | null>(null);
  const [ir, setIr] = useState<DeploymentIrResponse | null>(null);
  const [aiUsage, setAiUsage] = useState<DeploymentAiUsageResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      const [reportResult, irResult] = await Promise.allSettled([
        getDeploymentAnalysisReport(deploymentId),
        getDeploymentIr(deploymentId),
      ]);
      // AI 사용량은 부가 정보라 실패해도 화면에 오류를 띄우지 않는다.
      const usage = await getDeploymentAiUsage(deploymentId).catch(() => null);
      if (!active) return;
      setAiUsage(usage);
      setLoaded(true);
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
  const warnings = warningsOf(report?.warnings);
  const services = servicesOf(report?.services);
  const resources = resourcesOf(report?.resources);
  const irErrors = Array.isArray(report?.irErrors) ? report.irErrors.map(lineOf) : [];
  const unresolved = Array.isArray(report?.unresolved) ? report.unresolved.map(lineOf) : [];
  // 같은 소스를 다시 올리면 서버가 이전 분석을 재사용한다 (IR source = analyzer_cache).
  const reused = ir?.source === 'analyzer_cache';
  // 이미 끝난 배포인데 분석 결과가 없으면 "진행 중"이 아니라 "결과 없음"이다.
  const finished = deploymentStatus !== null && finishedStatuses.includes(deploymentStatus);
  const missing = finished && loaded && !report;
  return <section className="panel analysis-panel">
    <div className="panel-title"><div><h2>{t.analysis.title}</h2><p>{t.analysis.description}</p></div><span className="chip">{report ? t.analysis.done : missing ? t.analysis.none : t.analysis.running}</span></div>
    {error !== null && <div className="notice error"><strong>{t.analysis.error}</strong><br />{errorMessage(error, t, t.errors.analysisFailed)}</div>}
    {!report && error === null && <p>{missing ? t.analysis.noneCopy : t.analysis.pending}</p>}
    {report && <><div className="summary-grid"><div><small>{t.analysis.stack}</small><strong>{stack.length ? stack.join(', ') : t.analysis.stackUnknown}</strong></div><div><small>{t.analysis.services}</small><strong>{t.analysis.count(count(report.services))}</strong></div><div><small>{t.analysis.resources}</small><strong>{t.analysis.count(count(report.resources))}</strong></div><div><small>{t.analysis.warnings}</small><strong>{t.analysis.cases(count(report.warnings))}</strong></div></div>{reused && <p className="analysis-reused">{t.analysis.reused}</p>}
      {report.irValid === false && <div className="notice error" role="alert"><strong>{t.analysis.irInvalid}</strong>{irErrors.length > 0 && <ul className="analysis-lines">{irErrors.map((line, index) => <li key={index}>{line}</li>)}</ul>}</div>}
      {services.length > 0 && <div className="analysis-detail"><h3>{t.analysis.serviceList}</h3>{services.map((service) => <dl key={service.name} className="analysis-service">
        <div className="analysis-service__head"><dt>{service.name}</dt><dd>{service.stack || t.analysis.stackUnknown}</dd></div>
        <div><dt>{t.analysis.port}</dt><dd>{service.port ?? t.analysis.notDetected}</dd></div>
        <div><dt>{t.analysis.command}</dt><dd>{service.command ? <code>{service.command}</code> : t.analysis.notDetected}</dd></div>
        {service.path && <div><dt>{t.analysis.path}</dt><dd><code>{service.path}</code></dd></div>}
        {service.envNames.length > 0 && <div><dt>{t.analysis.envNames}</dt><dd><code>{service.envNames.join(', ')}</code></dd></div>}
      </dl>)}</div>}
      {resources.length > 0 && <div className="analysis-detail"><h3>{t.analysis.resourceList}</h3><ul className="analysis-lines">{resources.map((resource) => <li key={resource.name}><code>{resource.type}</code> {resource.name}</li>)}</ul></div>}
      {warnings.length > 0 && <div className="notice analysis-warnings"><strong>{t.analysis.riskTitle}</strong><ul>{warnings.map((warning, index) => <li key={`${warning.code}-${warning.path ?? index}`}><span className="analysis-warnings__label">{t.analysis.warningLabels[warning.code] ?? warning.code}</span><span>{warning.message}</span>{warning.path && <code>{warning.path}</code>}</li>)}</ul></div>}{unresolved.length > 0 && <><p className="muted-copy">{t.analysis.unresolved(unresolved.length)}</p><details className="technical-details"><summary>{t.analysis.unresolvedList}</summary><ul className="analysis-lines">{unresolved.map((line, index) => <li key={index}>{line}</li>)}</ul></details></>}</>}
    {aiUsage && aiUsage.totalTokenIn + aiUsage.totalTokenOut > 0 && <p className="muted-copy analysis-ai-usage">{t.analysis.aiUsage(aiUsage.totalTokenIn.toLocaleString(t.locale), aiUsage.totalTokenOut.toLocaleString(t.locale), aiUsage.totalCostUsd.toFixed(4))}</p>}
    <details className="technical-details"><summary>{t.analysis.irToggle}</summary>{ir ? <pre>{printable(ir.ir)}</pre> : <p>{finished ? t.analysis.irNone : t.analysis.irPending}</p>}</details>
  </section>;
}
