import { followAppLink, type Navigate } from '../../app/navigation';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { displayProjectName } from '../dashboard/format';
import { AppPicker } from './AppPicker';
import type { DeployTarget } from './TargetToggle';
import { setupStatus, type useDeployProject } from './useDeployProject';

type DeployProjectState = ReturnType<typeof useDeployProject>['state'];

/**
 * 간단 배포 화면의 연결 상태 한 줄. 등록 · 변경은 연결 설정 화면(/setup)에서 한다.
 */
export function SetupSummary({ target, state, onRetry, onNavigate, onSelectProject, disabled }: { target: DeployTarget; state: DeployProjectState; onRetry: () => void; onNavigate: Navigate; onSelectProject: (projectId: string) => void; disabled?: boolean }) {
  const { t } = useI18n();
  if (state.phase === 'loading') return <p className="setup-summary" aria-live="polite">{t.deploy.summary.checking}</p>;
  if (state.phase === 'error') return <div className="notice error" role="alert">
    <strong>{t.deploy.summary.checkError}</strong><br />{errorMessage(state.error, t, t.deploy.summary.checkError)}
    <div><Keycap variant="ghost" onClick={onRetry}>{t.dashboard.retry}</Keycap></div>
  </div>;

  const status = setupStatus(state);
  if (!status.ready) return null;
  const setupLink = <a className="setup-summary__link" href="/setup" onClick={(event) => followAppLink(event, onNavigate)}>{t.nav.setup}</a>;

  return <div className="setup-summary" aria-live="polite">
    {/* 앱이 여럿이면 여기서 바로 바꿀 수 있다. 어느 앱에 배포하는지 누르기 전에 보이게 한다. */}
    {status.projects.length > 1
      ? <AppPicker projects={status.projects} value={status.project?.id ?? null} onChange={onSelectProject} disabled={disabled} />
      : status.project && <span className="setup-summary__app">{displayProjectName(status.project.name)}</span>}
    {status.keysMissing
      ? <span className="setup-summary__item is-missing">{t.deploy.summary.keysMissing}</span>
      : !status.aws ? <span className="setup-summary__item is-missing">{t.deploy.summary.awsMissing}</span>
        : <span className="setup-summary__item is-ok">✓ AWS{status.aws.region ? ` · ${status.aws.region}` : ''}</span>}
    {target === 'onprem' && (status.onprem
      ? <span className="setup-summary__item is-ok">✓ {t.deploy.targets.onprem}{status.onprem.hostname ? ` · ${status.onprem.hostname}` : ''}</span>
      : <span className="setup-summary__item is-missing">{t.deploy.summary.onpremMissing}</span>)}
    {setupLink}
  </div>;
}
