import { STATIC_SITE_PROFILE } from '../../api/deployment-api';
import type { KoroMood } from '../../components/ui/Koro';
import type { Messages } from '../../i18n/ko';
import type { LogTag } from '../../i18n/log-lines';
import type { SoundName } from '../sound/sound-engine';
import type { SceneTarget } from './DeployScene';
import type { DeployStory, IrOrigin } from './deploy-story';

/**
 * 기다리는 동안 코로가 하는 말과 몸짓.
 * 진행률을 지어내지 않는다 — 쓰는 재료는 서버가 준 단계, 그 단계에서 실제로 흐른 시간, AI 분석 결과, 배포할 곳,
 * 그리고 서버가 남긴 단계 로그(키)와 헬스체크 현황뿐이다.
 */

/** 분석 리포트에서 말풍선에 쓸 사실만 꺼낸 것 */
export interface AnalysisFacts { stack: string | null; port: number | null; services: number; /** 서버 없는 정적 사이트 (#275) */ staticSite: boolean }

export function readAnalysisFacts(services: unknown): AnalysisFacts | null {
  if (!Array.isArray(services) || !services.length) return null;
  const first = services[0] as { framework?: unknown; language?: unknown; port?: unknown; type?: unknown } | null;
  const name = (value: unknown) => (typeof value === 'string' && value.trim() ? value : null);
  return {
    stack: name(first?.framework) ?? name(first?.language),
    port: typeof first?.port === 'number' ? first.port : null,
    services: services.length,
    staticSite: services.length === 1 && first?.type === 'static',
  };
}

/** AWS 정적 사이트 프로필 — 서버 없이 S3 웹사이트로 서빙한다 (#275) */
export function isAwsStaticSiteProfile(profile: string | null): boolean {
  return profile === STATIC_SITE_PROFILE;
}

/** 한 문장을 보여 주는 시간(초) */
const LINE_SECONDS = 7;

/** 무엇으로 실행하는 배포인지 — 컨테이너(ECS · 온프레미스 Docker) · 서버리스(Lambda) · 정적 사이트(S3) */
export type Runtime = 'container' | 'serverless' | 'static';

/** 검증 단계의 헬스체크 현황에서 말풍선에 쓸 것 (서버가 준 값 그대로) */
export interface TalkHealth { passed: number; required: number; phase: 'target' | 'origin_switching' | 'public_url' | null; lastFailed: boolean }

export interface TalkContext {
  stage: number;
  /** 이 단계에서 흐른 시간(초) */
  stepSeconds: number;
  facts: AnalysisFacts | null;
  target: SceneTarget;
  story: DeployStory | null;
  ir: IrOrigin | null;
  runtime: Runtime;
  /** 이번 배포의 프로필 — 지금까지 서비스하던 배포와 같은 프로필이면 인프라가 이미 있다 */
  profile: string | null;
  /** 서버가 마지막으로 남긴 로그(키가 붙은 줄)와 그 뒤로 흐른 시간(초). 없으면 정해 둔 문장만 쓴다 */
  log: { tag: LogTag; seconds: number } | null;
  health: TalkHealth | null;
}

/**
 * 지금 코로가 할 말.
 *  1) 검증 단계에서 헬스체크 현황을 받았으면 그 숫자와 단계를 그대로 말한다.
 *  2) 서버가 방금 남긴 로그가 지금 단계의 것이면 그 일을 먼저 말한다 (그 뒤로는 상황 설명과 번갈아).
 *  3) 그 밖에는 단계 · 배포 종류 · 배포할 곳에 맞는 문장을 차례로 돌린다.
 */
export function koroLine(context: TalkContext, t: Messages): string | null {
  const { stage, stepSeconds, story, log, health } = context;
  const talk = t.run.talk;
  // 전에 만든 이미지를 다시 쓰는 배포(롤백 · 재배포 · 환경 전환)는 "새 버전"이 아니다 (#322).
  const fill = (line: string) => line.replaceAll('{v}', story?.reused ? talk.versionSame : talk.versionNew);
  const pick = (lines: string[], seconds: number) => (lines.length ? fill(lines[Math.floor(Math.max(0, seconds) / LINE_SECONDS) % lines.length]) : null);

  if (stage === 4 && health) {
    // 환경 전환은 새 곳을 확인하는 동안 지금 환경이 계속 서비스한다는 것을 사이사이 알린다
    const keeps = story?.kind === 'switch' && health.phase !== 'origin_switching' && health.phase !== 'public_url' ? [talk.switchKeeps] : [];
    return pick([healthLine(health, talk), ...keeps], stepSeconds);
  }

  const base = irLines(stage, context.ir, story, talk).concat(storyLines(context, talk), stageLines(context, talk));
  const live = log ? liveLine(log.tag, stage, talk) : null;
  return live !== null ? pick([live, ...base], log!.seconds) : pick(base, stepSeconds);
}

/** 헬스체크 현황을 말로. 숫자는 서버가 준 값이다 */
function healthLine(health: TalkHealth, talk: Messages['run']['talk']): string {
  if (health.phase === 'origin_switching') return talk.health.switching;
  if (health.phase === 'public_url') return talk.health.publicUrl;
  if (health.lastFailed) return talk.health.retry;
  if (health.passed >= health.required) return talk.health.full(health.required);
  return health.passed === 0 ? talk.health.first : talk.health.count(health.passed, health.required);
}

/** 로그 키가 어느 단계의 일인지 — 지난 단계의 로그를 지금 단계의 일처럼 말하지 않는다 */
function logStage(key: string): number[] {
  if (key === 'provision.agentJobSaved') return [2, 3]; // 일을 넘긴 뒤에는 "배포" 단계에서 에이전트를 기다린다
  if (key.startsWith('analyze.')) return [0];
  if (key.startsWith('build.')) return [1];
  if (key.startsWith('ecs.') || key.startsWith('lambda.') || key.startsWith('static.') || key === 'provision.staticExtract') return [3];
  if (key.startsWith('provision.') || key.startsWith('terraform.')) return [2];
  if (key.startsWith('verify.')) return [4];
  return [];
}

/** 서버가 방금 남긴 로그를 쉬운 말로. 말할 만한 키가 아니거나 다른 단계의 로그면 null */
function liveLine(tag: LogTag, stage: number, talk: Messages['run']['talk']): string | null {
  if (!logStage(tag.key).includes(stage)) return null;
  const say = (talk.live as Record<string, ((params: LogTag['params']) => string) | undefined>)[tag.key];
  return say ? say(tag.params) : null;
}

/**
 * IR(배포 명세)이 어디서 왔는지 — 분석 바로 다음 단계(빌드)에서 먼저 말한다.
 * 복사한 IR이면 왜 분석을 건너뛰는지, 새로 만든 IR이면 방금 만들었다는 것을 알린다.
 */
function irLines(stage: number, ir: IrOrigin | null, story: DeployStory | null, talk: Messages['run']['talk']): string[] {
  if (stage !== 1 || ir === null) return [];
  if (ir === 'copied') return [story?.kind === 'rollback' ? talk.irCopiedRollback : story?.kind === 'switch' ? talk.irCopiedSwitch : talk.irCopied];
  return ir === 'ai' ? [talk.irCreated, talk.irAi] : [talk.irCreated];
}

/** 재배포 · 롤백 · 환경 전환일 때 먼저 하는 말 */
function storyLines({ stage, story, target, runtime }: TalkContext, talk: Messages['run']['talk']): string[] {
  if (!story) return [];
  // AWS의 같은 환경 컨테이너 배포는 서비스 하나를 제자리에서 새 버전으로 바꾼다 (배포 단계의 ECS 롤아웃에서 일어난다, #253).
  const inPlace = story.prev !== null && story.kind !== 'switch' && target !== 'onprem' && runtime === 'container';
  // "같은 이미지, 장소만 바꾼다"는 지금 서비스 중인 버전과 이름표가 같을 때만 말한다 (환경을 바꾸면서 예전 이미지로 되돌리는 경우도 있다).
  const sameImage = story.prev !== null && story.prev.label === story.label;
  if (stage === 1 && story.kind === 'update') return [talk.update];
  if (stage === 1 && story.reused) return [talk.reuse, ...(story.kind === 'switch' && sameImage ? [talk.reuseSwitch] : story.kind === 'rollback' ? [talk.rollback(story.label)] : [])];
  if (stage >= 2 && stage <= 4 && story.kind === 'switch') return [talk.switchKeeps];
  // 되돌린다는 말은 올리는 동안에만 한다. 검증 단계에서는 이미 올린 뒤다
  if (stage >= 2 && stage <= 3 && story.kind === 'rollback') return [talk.rollback(story.label), ...(inPlace && stage === 3 ? [talk.awsInPlace] : [])];
  if (stage === 3 && inPlace) return [talk.awsInPlace];
  return [];
}

function stageLines({ stage, facts, target, story, runtime, profile }: TalkContext, talk: Messages['run']['talk']): string[] {
  const reused = story?.reused === true;
  if (stage === 0) return [...talk.analyze];
  if (stage === 1) {
    if (reused) return [];
    return [...(facts?.stack ? [facts.port ? talk.foundStackPort(facts.stack, facts.port) : talk.foundStack(facts.stack)] : []), ...(facts && facts.services > 1 ? [talk.foundServices(facts.services)] : []), ...talk.build];
  }
  if (stage === 2) {
    const settings = reused ? talk.provisionReused : talk.provision;
    if (target === 'onprem') return [...talk.provisionOnprem, ...settings];
    // 지금까지 같은 곳 · 같은 프로필로 서비스하고 있었으면 인프라가 이미 있다. 그 밖에는(처음 · 환경 전환 · 형태 변경) 있는지 알 수 없어 "준비한다"고만 말한다
    const existing = story?.prev != null && story.kind !== 'switch' && story.prev.profile !== null && story.prev.profile === profile;
    const place = runtime === 'serverless' ? (existing ? talk.provisionServerlessExisting : talk.provisionServerless)
      : runtime === 'static' ? talk.provisionStatic
        : existing ? talk.provisionAwsExisting : story?.kind === 'switch' ? talk.provisionAwsSwitch : talk.provisionAws;
    return [...place, ...settings];
  }
  if (stage === 3) {
    if (target === 'onprem') return [...(reused ? talk.deployOnpremReused : talk.deployOnprem)];
    return [...(runtime === 'serverless' ? talk.deployServerless : runtime === 'static' ? talk.deployStatic : talk.deploy)];
  }
  return stage === 4 ? [...talk.verify] : [];
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

/**
 * 코로가 새 일을 시작할 때 낼 효과음. 단계와 여정(배포할 곳 · 재사용 · 환경 전환)에 맞춘다.
 * 반복해서 울리지 않는다 — 단계가 바뀌는 순간에 한 번만 낸다.
 */
export function sceneCue(stage: number | null, target: SceneTarget, story: DeployStory | null): SoundName | null {
  const moving = story !== null && story.kind === 'switch' && story.reused;
  switch (stage) {
    case 0: return 'scan';
    case 1: return moving ? null : story?.reused ? 'warehouse' : 'hammer';
    case 2: return target === 'onprem' && !moving ? 'robot' : 'wrench';
    case 3: return target === 'onprem' ? (moving ? 'parachute' : 'roll') : 'takeoff';
    case 4: return 'check';
    default: return null;
  }
}
