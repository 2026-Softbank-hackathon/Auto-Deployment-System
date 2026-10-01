import type { EnvironmentSummary } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { AwsKeyForm } from './AwsKeyForm';
import type { DeployTarget } from './TargetToggle';
import { missingFor, type useDeployProject } from './useDeployProject';

type DeployProjectState = ReturnType<typeof useDeployProject>['state'];

/**
 * 고른 대상에 배포할 준비가 됐는지 보여 준다. AWS 키가 없으면 그 자리에서 등록받고,
 * 온프레미스 환경은 아직 등록 화면이 없어서 안내만 한다.
 */
export function DeployReadiness({ target, state, onRetry, onRegisterAws }: {
  target: DeployTarget;
  state: DeployProjectState;
  onRetry: () => void;
  onRegisterAws: (input: { accessKeyId: string; secretAccessKey: string; region: string }) => Promise<void>;
}) {
  const { t } = useI18n();
  if (state.phase === 'loading') return <p className="deploy-readiness" aria-live="polite">{t.deploy.readiness.checking}</p>;
  if (state.phase === 'error') return <div className="notice error deploy-readiness" role="alert">
    <strong>{t.deploy.readiness.checkError}</strong><br />{errorMessage(state.error, t, t.deploy.readiness.checkError)}
    <div><Keycap variant="ghost" onClick={onRetry}>{t.dashboard.retry}</Keycap></div>
  </div>;

  const missing = missingFor(target, state.environments);
  const defaultOf = (type: EnvironmentSummary['type']) => state.environments.find((environment) => environment.type === type && environment.isDefault);
  const aws = defaultOf('aws');
  const onprem = defaultOf('onprem');

  return <div className="deploy-readiness" aria-live="polite">
    {aws && <p className="deploy-readiness__ok">✓ {t.deploy.readiness.awsReady}{aws.region ? ` · ${aws.region}` : ''}</p>}
    {target === 'onprem' && onprem && <p className="deploy-readiness__ok">✓ {t.deploy.readiness.onpremReady}{onprem.hostname ? ` · ${onprem.hostname}` : ''}</p>}
    {missing.includes('aws') && <div className="notice deploy-readiness__need">
      <strong>{t.deploy.readiness.awsNeeded}</strong>
      <p>{target === 'onprem' ? t.deploy.readiness.awsNeededOnprem : t.deploy.readiness.awsNeededCopy}</p>
      <AwsKeyForm onSubmit={onRegisterAws} />
    </div>}
    {missing.includes('onprem') && <div className="notice deploy-readiness__need">
      <strong>{t.deploy.readiness.onpremNeeded}</strong>
      <p>{t.deploy.readiness.onpremNeededCopy}</p>
    </div>}
  </div>;
}
