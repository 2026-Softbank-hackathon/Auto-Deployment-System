import { Koro, type KoroMood } from '../../components/ui/Koro';
import { useI18n } from '../../i18n/I18nProvider';
import type { DeploymentStatusView } from '../deployment-status/status-view';
import type { SceneTarget } from './DeployScene';
import type { DeployStory } from './deploy-story';
import type { AnalysisFacts } from './koro-talk';

/**
 * 진행 화면의 기본 모습. "버튼 한 번 누르면 나머지는 자동"을 그대로 보여 준다:
 * 지금 하는 일 한 문장과, 지금까지 자동으로 끝낸 일의 목록.
 * 목록은 서버가 알려 준 단계와 분석 결과로만 만든다 — 끝나지 않은 일은 적지 않는다.
 * 실패 · 중단은 서버가 멈춘 단계를 주지 않으므로(stage = null) 목록을 그리지 않는다.
 */
interface SimpleProgressProps {
  view: DeploymentStatusView;
  target: SceneTarget;
  /** 지금 단계에서 코로가 하는 말 (일하는 중일 때만) */
  talk: string | null;
  facts: AnalysisFacts | null;
  story: DeployStory | null;
  mood: KoroMood;
}

export function SimpleProgress({ view, target, talk, facts, story, mood }: SimpleProgressProps) {
  const { t } = useI18n();
  const copy = t.run.simple;
  const stage = view.stage;
  if (stage === null) return null;
  const succeeded = view.outcome === 'success';
  const reused = story?.reused === true;

  const done: string[] = [];
  if (!reused && stage >= 1 && facts?.stack) done.push(facts.port ? copy.foundStackPort(facts.stack, facts.port) : copy.foundStack(facts.stack));
  if (reused && story && stage >= 1) done.push(copy.reusedImage(story.label));
  if (!reused && stage >= 2) done.push(copy.builtImage);
  if (stage >= 3) done.push(target === 'onprem' ? copy.preparedOnprem : target === 'aws' ? copy.preparedAws : copy.prepared);
  if (stage >= 4) done.push(copy.deployed);
  if (succeeded) done.push(copy.verified);

  return <div className="run-simple">
    <div className="run-simple__now">
      <Koro mood={mood} size={56} />
      <div>
        <p className="run-simple__headline">{succeeded ? copy.headlineDone : view.waiting ? copy.headlineWaiting : copy.headline}</p>
        <p className="run-simple__talk">{talk ?? (succeeded ? copy.subDone : copy.sub)}</p>
      </div>
    </div>
    {done.length > 0 && <div className="run-simple__auto">
      <h2>{copy.autoTitle}</h2>
      <ul>{done.map((item) => <li key={item}><span aria-hidden="true">✓</span> {item}</li>)}</ul>
    </div>}
  </div>;
}
