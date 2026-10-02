import type { KoroMood } from '../../components/ui/Koro';
import type { Messages } from '../../i18n/ko';
import type { SceneTarget } from './DeployScene';
import type { DeployStory } from './deploy-story';

/**
 * 기다리는 동안 코로가 하는 말과 몸짓.
 * 진행률을 지어내지 않는다 — 쓰는 재료는 서버가 준 단계, 그 단계에서 실제로 흐른 시간, AI 분석 결과, 배포할 곳뿐이다.
 */

/** 분석 리포트에서 말풍선에 쓸 사실만 꺼낸 것 */
export interface AnalysisFacts { stack: string | null; port: number | null; services: number }

export function readAnalysisFacts(services: unknown): AnalysisFacts | null {
  if (!Array.isArray(services) || !services.length) return null;
  const first = services[0] as { framework?: unknown; language?: unknown; port?: unknown } | null;
  const name = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  return {
    stack: name(first?.framework) ?? name(first?.language),
    port: typeof first?.port === 'number' ? first.port : null,
    services: services.length,
  };
}

/** 한 문장을 보여 주는 시간(초) */
const LINE_SECONDS = 7;

/** 지금 단계에서 코로가 할 말. 단계에서 흐른 시간에 따라 차례로 돌아간다. */
export function koroLine(stage: number, stepSeconds: number, facts: AnalysisFacts | null, target: SceneTarget, t: Messages, story: DeployStory | null = null): string | null {
  const talk = t.run.talk;
  const lines = storyLines(stage, story, talk).concat(stageLines(stage, facts, target, talk, story?.reused === true));
  if (!lines.length) return null;
  return lines[Math.floor(Math.max(0, stepSeconds) / LINE_SECONDS) % lines.length];
}

/** 재배포 · 롤백 · 환경 전환일 때 먼저 하는 말 */
function storyLines(stage: number, story: DeployStory | null, talk: Messages['run']['talk']): string[] {
  if (!story) return [];
  if (stage === 1 && story.reused) return [talk.reuse, ...(story.kind === 'switch' ? [talk.reuseSwitch] : story.kind === 'rollback' ? [talk.rollback(story.label)] : [])];
  if (stage >= 2 && stage <= 4 && story.kind === 'switch') return [talk.switchKeeps];
  if (stage >= 2 && stage <= 4 && story.kind === 'rollback') return [talk.rollback(story.label)];
  return [];
}

function stageLines(stage: number, facts: AnalysisFacts | null, target: SceneTarget, talk: Messages['run']['talk'], reused: boolean): string[] {
  if (stage === 1 && reused) return [];
  const lines: string[] = stage === 0 ? [...talk.analyze]
    : stage === 1 ? [...(facts?.stack ? [facts.port ? talk.foundStackPort(facts.stack, facts.port) : talk.foundStack(facts.stack)] : []), ...(facts && facts.services > 1 ? [talk.foundServices(facts.services)] : []), ...talk.build]
      : stage === 2 ? [...(target === 'onprem' ? talk.provisionOnprem : talk.provisionAws), ...talk.provision]
        : stage === 3 ? [...talk.deploy]
          : stage === 4 ? [...talk.verify] : [];
  return lines;
}

export interface KoroIdle { mood: KoroMood; dozing: boolean }

/**
 * 한 단계에 오래 머물수록 코로의 모습이 바뀐다: 처음엔 평소대로, 조금 지나면 두리번거리고 하품하고, 2분이 넘으면 존다.
 * 단계가 바뀌면 흐른 시간이 0으로 돌아가므로 다시 깬다.
 */
export function koroIdle(stepSeconds: number): KoroIdle {
  if (stepSeconds < 20) return { mood: 'normal', dozing: false };
  if (stepSeconds < 120) {
    const beat = (stepSeconds - 20) % 30;
    return { mood: beat < 12 ? 'curious' : beat < 16 ? 'yawn' : 'normal', dozing: false };
  }
  const beat = (stepSeconds - 120) % 40;
  if (beat < 5) return { mood: 'yawn', dozing: false };
  if (beat < 30) return { mood: 'sleepy', dozing: true };
  return { mood: 'curious', dozing: false };
}
