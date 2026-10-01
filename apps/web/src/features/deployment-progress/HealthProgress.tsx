import { useEffect, useState } from 'react';
import { getDeploymentHealth, type DeploymentHealthResponse } from '../../api/deployment-api';
import { useI18n } from '../../i18n/I18nProvider';

const POLL_MS = 3000;
const finishedStatuses = ['succeeded', 'failed'];

/**
 * 검증 단계의 헬스체크 현황 (API-21). 연속 통과 횟수는 서버가 준 값만 보여 준다.
 * 검증 중에는 주기적으로 다시 조회하고, 끝난 배포는 한 번만 조회한다. 기록이 없으면(404) 아무것도 그리지 않는다.
 */
export function HealthProgress({ deploymentId, status }: { deploymentId: string; status: string | null }) {
  const { t } = useI18n();
  const [health, setHealth] = useState<DeploymentHealthResponse | null>(null);
  const verifying = status === 'verifying';
  const finished = status !== null && finishedStatuses.includes(status);

  useEffect(() => {
    if (!verifying && !finished) return;
    let active = true;
    const load = () => { getDeploymentHealth(deploymentId).then((next) => { if (active) setHealth(next); }, () => { /* 현황은 없어도 진행 화면은 동작한다 */ }); };
    load();
    if (!verifying) return () => { active = false; };
    const timer = window.setInterval(load, POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [deploymentId, verifying, finished]);

  if (!health) return null;
  const last = health.checks[health.checks.length - 1];
  return <div className={`health-progress is-${health.status}`} role="status">
    <strong>{t.run.healthTitle}</strong>
    <span className="health-progress__dots" aria-hidden="true">
      {Array.from({ length: health.requiredPasses }, (_, index) => <span key={index} className={index < health.consecutivePassed ? 'is-passed' : undefined} />)}
    </span>
    <span>{t.run.healthCount(health.consecutivePassed, health.requiredPasses)}</span>
    {last && <span className="health-progress__last">{t.run.healthLast(last.attempt)} · {last.passed ? t.run.healthPassed : t.run.healthFailed}{last.statusCode !== undefined ? ` · HTTP ${last.statusCode}` : ''}{last.latencyMs !== undefined ? ` · ${last.latencyMs}ms` : ''}</span>}
  </div>;
}
