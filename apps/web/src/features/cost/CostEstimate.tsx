import { useEffect, useState } from 'react';
import { getDeploymentCostEstimate, type MonthlyCostEstimate } from '../../api/deployment-api';
import { useI18n } from '../../i18n/I18nProvider';

const usd = (value: number) => value.toFixed(2);

/**
 * 월 예상 인프라 비용 (#327). 배포의 프로필 · IR 로 서버가 계산한 추정치를 한 줄로 보여 주고, 항목은 펼쳐서 본다.
 * 프로필이 정해지기 전(분석 전)이거나 불러오지 못하면 아무것도 그리지 않는다 — 부가 정보라 오류를 띄우지 않는다.
 * profileKey 가 바뀌면(분석이 끝나 프로필이 정해짐 · 환경 전환) 다시 받는다.
 */
export function CostEstimate({ deploymentId, profileKey }: { deploymentId: string; profileKey?: string | null }) {
  const { t } = useI18n();
  const copy = t.cost;
  const [estimate, setEstimate] = useState<MonthlyCostEstimate | null>(null);

  useEffect(() => {
    let active = true;
    getDeploymentCostEstimate(deploymentId).then((next) => { if (active) setEstimate(next); }, () => { if (active) setEstimate(null); });
    return () => { active = false; };
  }, [deploymentId, profileKey]);

  if (!estimate) return null;
  const onprem = estimate.region === null;
  return <details className="technical-details cost-estimate">
    <summary>
      <span className="cost-estimate__label">{copy.title}</span>
      <strong>{estimate.monthlyUsd > 0 ? copy.total(usd(estimate.monthlyUsd)) : copy.free}</strong>
      <span className="cost-estimate__toggle">{copy.details}</span>
    </summary>
    <ul className="cost-estimate__items">
      {estimate.items.map((item) => <li key={item.key}>
        <span>{copy.items[item.key] ?? item.key}</span>
        <span>{item.usageBased ? copy.usageBased : `$${usd(item.monthlyUsd)}`}</span>
      </li>)}
    </ul>
    <p className="cost-estimate__note">{onprem ? copy.onpremNote : copy.note(estimate.region ?? '')}</p>
  </details>;
}
