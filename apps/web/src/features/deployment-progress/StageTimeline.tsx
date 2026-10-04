import { useEffect, useState } from 'react';
import { deploymentLogSteps, getDeploymentLogs, type DeploymentLogStep } from '../../api/deployment-api';
import { useI18n } from '../../i18n/I18nProvider';
import { elapsed } from '../dashboard/format';

interface StageLog { step: DeploymentLogStep; first: number; reused: boolean }
interface StageSpan { step: DeploymentLogStep; startedAt: number; ms: number }

/** 로그 줄 앞의 "[ISO 시각]". 시각이 없는 줄은 건너뛴다. */
function lineTimes(log: string): number[] {
  return log.split('\n').flatMap((line) => {
    const time = Date.parse(line.match(/^\[([^\]]+)\]/)?.[1] ?? '');
    return Number.isNaN(time) ? [] : [time];
  });
}

/**
 * 전체 걸린 시간(생성 ~ 완료)을 단계에 나눈다. 서버가 단계별 시간을 주지 않아 화면에서 나눈 값이다(측정값 아님).
 * - 경계는 각 단계 로그의 첫 줄 시각. 한 단계는 다음 단계가 시작할 때까지로 본다.
 * - 첫 단계는 생성 시각부터, 마지막 단계는 완료 시각까지 — 그래서 합계가 전체 걸린 시간과 같다.
 *   (로그가 남지 않는 대기 · 배포 · 검증 시간은 그 앞 단계에 들어간다)
 * - 이미지를 재사용한 빌드(재배포)는 0으로 고정하고, 그 시간은 다음 단계가 가져간다.
 */
function distribute(logs: StageLog[], from: number, to: number): StageSpan[] {
  const spans: StageSpan[] = [];
  let cursor = from;
  logs.forEach((log, index) => {
    if (log.reused) { spans.push({ step: log.step, startedAt: cursor, ms: 0 }); return; }
    const next = logs.slice(index + 1).find((later) => !later.reused);
    const end = Math.min(to, Math.max(cursor, next ? next.first : to));
    spans.push({ step: log.step, startedAt: cursor, ms: end - cursor });
    cursor = end;
  });
  return spans;
}

/**
 * 단계별 걸린 시간. 단계 로그의 시각과 배포의 생성 · 완료 시각으로 전체 시간을 나눠 보여 준다(distribute).
 * 로그가 없거나 시각을 읽지 못한 단계는 빼고, 하나도 없으면 아무것도 그리지 않는다.
 */
export function StageTimeline({ deploymentId, createdAt, finishedAt }: { deploymentId: string; /** 배포 생성 시각 (ISO) */ createdAt: string; /** 배포 완료 시각 (ISO) */ finishedAt: string }) {
  const { t } = useI18n();
  const [logs, setLogs] = useState<StageLog[]>([]);

  useEffect(() => {
    let active = true;
    void Promise.allSettled(deploymentLogSteps.map((step) => getDeploymentLogs(deploymentId, step))).then((results) => {
      if (!active) return;
      setLogs(results.flatMap((result, index) => {
        if (result.status !== 'fulfilled' || !result.value) return [];
        const times = lineTimes(result.value);
        if (!times.length) return [];
        const step = deploymentLogSteps[index];
        return [{ step, first: Math.min(...times), reused: step === 'build' && result.value.includes('"k":"build.reuseImage"') }];
      }));
    });
    return () => { active = false; };
  }, [deploymentId]);

  const from = Date.parse(createdAt);
  const to = Date.parse(finishedAt);
  if (!logs.length || Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  const spans = distribute(logs, from, to);
  const longest = Math.max(...spans.map((span) => span.ms), 1);

  return <section className="stage-timeline" aria-labelledby="stage-timeline-title">
    <h2 id="stage-timeline-title">{t.result.timelineTitle}</h2>
    <ol>
      {spans.map((span, index) => <li key={span.step} style={{ animationDelay: `${index * 70}ms` }}>
        <span className="stage-timeline__name">{t.progress.logSteps[span.step]}</span>
        <span className="stage-timeline__bar" aria-hidden="true"><span style={{ width: `${Math.max(2, (span.ms / longest) * 100)}%` }} /></span>
        <span className="stage-timeline__time">{elapsed(new Date(span.startedAt).toISOString(), span.startedAt + span.ms)}</span>
      </li>)}
    </ol>
  </section>;
}
