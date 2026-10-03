import { useI18n } from '../../i18n/I18nProvider';
import { LiveSwitchScene } from './LiveSwitchScene';
import type { LiveSwitch } from './useProjectLive';

/**
 * 실행 환경이 온프레미스에서 AWS 로 바뀐 것을 확인했을 때의 안내 — 전환 장면 + 글자 알림 (#349).
 * 앱 상세 · 배포 진행 · 배포 결과 화면이 같이 쓴다. 보고 있는 화면이 어디든 같은 모습으로 알린다.
 *
 * 서버는 전환 이유나 진행 상태를 알려 주지 않으므로 바뀐 사실만 말한다.
 * 알림 영역(role=status)은 미리 그려 두어야 화면 낭독기가 읽는다. 장면은 그 밖에 두어 제목 · 설명만 한 번 읽히게 한다.
 */
export function LiveSwitchNotice({ liveSwitch, onDismiss, scene = true }: { liveSwitch: LiveSwitch | null; onDismiss: () => void; /** false 면 글자 알림만 (배포 진행 화면은 배포 장면 안에서 직접 보여 준다) */ scene?: boolean }) {
  const { t } = useI18n();
  const copy = t.projects.liveSwitch;
  return <div className="live-switch">
    {scene && liveSwitch && <LiveSwitchScene liveSwitch={liveSwitch} />}
    <div className={`page-toast ${scene && liveSwitch ? 'has-scene' : ''}`} role="status" aria-live="polite">
      {liveSwitch && <div className="toast is-success">
        <div className="toast__body">
          <strong>{copy.title}</strong>
          <span>{copy.copy}</span>
        </div>
        <span />
        <button type="button" className="toast__close" aria-label={t.notify.close} onClick={onDismiss}>×</button>
      </div>}
    </div>
  </div>;
}
