import { followAppLink, type Navigate } from '../../app/navigation';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { displayProjectName } from '../dashboard/format';
import type { DeployTarget } from './TargetToggle';
import { setupStatus, type useDeployProject } from './useDeployProject';

type DeployProjectState = ReturnType<typeof useDeployProject>['state'];

/**
 * 간단 배포 화면의 프로젝트 줄: 배포할 프로젝트와 그 연결 상태를 보여 주고, 버튼으로 프로젝트 선택 모달을 연다.
 * usable이 false면(고른 프로젝트의 필수 연결이 없으면) 고르지 않은 것으로 보여 준다.
 */
export function SetupSummary({ target, state, usable, envMissing = 0, onRetry, onNavigate, onPick, disabled }: {
  target: DeployTarget; state: DeployProjectState; /** 고른 프로젝트가 배포할 수 있는 상태인지 */ usable: boolean; /** 등록이 필요한 환경변수 개수 */ envMissing?: number;
  onRetry: () => void; onNavigate: Navigate; /** 프로젝트 선택 모달을 연다 */ onPick: () => void; disabled?: boolean;
}) {
  const { t } = useI18n();
  if (state.phase === 'loading') return <p className="setup-summary" aria-live="polite">{t.deploy.summary.checking}</p>;
  if (state.phase === 'error') return <div className="notice error" role="alert">
    <strong>{t.deploy.summary.checkError}</strong><br />{errorMessage(state.error, t, t.deploy.summary.checkError)}
    <div><Keycap variant="ghost" onClick={onRetry}>{t.dashboard.retry}</Keycap></div>
  </div>;

  const status = setupStatus(state);
  if (!status.ready) return null;
  const chosen = usable ? status.project : null;

  return <div className="setup-summary" aria-live="polite">
    <span className="setup-summary__label">{t.deploy.summary.appLabel}</span>
    {chosen
      ? <span className="setup-summary__app">{displayProjectName(chosen.name)}</span>
      : <span className="setup-summary__item is-missing">{t.deploy.summary.notChosen}</span>}
    {chosen && status.aws && <span className="setup-summary__item is-ok">✓ AWS{status.aws.region ? ` · ${status.aws.region}` : ''}</span>}
    {chosen && target === 'onprem' && (status.onprem
      ? <span className="setup-summary__item is-ok">✓ {t.deploy.targets.onprem}{status.onprem.hostname ? ` · ${status.onprem.hostname}` : ''}</span>
      : <span className="setup-summary__item is-missing">{t.deploy.summary.onpremMissing}</span>)}
    {chosen && envMissing > 0 && <a className="setup-summary__item is-missing" href={`/projects/${encodeURIComponent(chosen.id)}/env`} onClick={(event) => followAppLink(event, onNavigate)}>{t.deploy.summary.envMissing(envMissing)}</a>}
    <Keycap variant="secondary" disabled={disabled} onClick={onPick}>{chosen ? t.deploy.summary.change : t.deploy.summary.pick}</Keycap>
  </div>;
}
