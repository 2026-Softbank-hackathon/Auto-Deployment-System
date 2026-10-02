import { useEffect, useState } from 'react';
import { deploymentLogSteps, getDeploymentLogs, type DeploymentLogStep } from '../../api/deployment-api';
import { useI18n } from '../../i18n/I18nProvider';
import { elapsed } from '../dashboard/format';

interface StageSpan { step: DeploymentLogStep; startedAt: string; ms: number }

/** 로그 줄 앞의 "[ISO 시각]". 시각이 없는 줄은 건너뛴다. */
function lineTimes(log: string): number[] {
  return log.split('\n').flatMap((line) => {
    const time = Date.parse(line.match(/^\[([^\]]+)\]/)?.[1] ?? '');
    return Number.isNaN(time) ? [] : [time];
  });
}

/**
 * 단계별 걸린 시간. 서버가 남긴 단계 로그의 첫 줄과 마지막 줄 시각 차이로 계산한다(지어낸 값 없음).
 * 로그가 없거나 시각을 읽지 못한 단계는 빼고, 하나도 없으면 아무것도 그리지 않는다.
 */
export function StageTimeline({ deploymentId }: { deploymentId: string }) {
  const { t } = useI18n();
  const [spans, setSpans] = useState<StageSpan[]>([]);

  useEffect(() => {
    let active = true;
    void Promise.allSettled(deploymentLogSteps.map((step) => getDeploymentLogs(deploymentId, step))).then((results) => {
      if (!active) return;
      setSpans(results.flatMap((result, index) => {
        if (result.status !== 'fulfilled' || !result.value) return [];
        const times = lineTimes(result.value);
        if (!times.length) return [];
        const first = Math.min(...times);
        return [{ step: deploymentLogSteps[index], startedAt: new Date(first).toISOString(), ms: Math.max(...times) - first }];
      }));
    });
    return () => { active = false; };
  }, [deploymentId]);

  if (!spans.length) return null;
  const longest = Math.max(...spans.map((span) => span.ms), 1);

  return <section className="stage-timeline" aria-labelledby="stage-timeline-title">
    <h2 id="stage-timeline-title">{t.result.timelineTitle}</h2>
    <ol>
      {spans.map((span, index) => <li key={span.step} style={{ animationDelay: `${index * 70}ms` }}>
        <span className="stage-timeline__name">{t.progress.logSteps[span.step]}</span>
        <span className="stage-timeline__bar" aria-hidden="true"><span style={{ width: `${Math.max(2, (span.ms / longest) * 100)}%` }} /></span>
        <span className="stage-timeline__time">{elapsed(span.startedAt, Date.parse(span.startedAt) + span.ms)}</span>
      </li>)}
    </ol>
  </section>;
}
