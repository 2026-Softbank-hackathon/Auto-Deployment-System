import { GadgetIcon, type GadgetKind } from '../../components/ui/GadgetIcon';
import { Koro } from '../../components/ui/Koro';
import { Rail } from '../../components/ui/Rail';
import { useI18n } from '../../i18n/I18nProvider';

const stops: ReadonlyArray<GadgetKind> = ['source', 'analyze', 'build', 'provision', 'deploy', 'verify', 'done'];

/** 간단 배포 화면 상단 레일. 배포 시작 전이므로 첫 정거장(소스 넣기)만 상태를 가진다. */
export function PipelineRail({ sourceReady }: { sourceReady: boolean }) {
  const { t } = useI18n();
  return <Rail className="pipeline-rail">
    <ol className="pipeline-rail__stops" aria-label={t.deploy.railLabel}>
      {stops.map((stop, index) => {
        const first = index === 0;
        const stateClass = first ? (sourceReady ? 'is-ready' : 'is-current') : 'is-pending';
        return <li key={stop} className={`pipeline-rail__stop ${stateClass}`} aria-current={first && !sourceReady ? 'step' : undefined}>
          <span className="pipeline-rail__station">
            {first && sourceReady ? <Koro size={26} className="pipeline-rail__koro" /> : <GadgetIcon kind={stop} size={stop === 'done' ? 22 : 20} />}
          </span>
          <span className="pipeline-rail__label">{first ? t.deploy.railSource : t.stages[stop]}</span>
          {first && <span className="pipeline-rail__note">{sourceReady ? t.deploy.railReady : t.deploy.railHere}</span>}
        </li>;
      })}
    </ol>
  </Rail>;
}
