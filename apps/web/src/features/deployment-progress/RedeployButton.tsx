import { useState } from 'react';
import { DeploymentApiError, redeployDeployment } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';

/**
 * 재배포 (#138): 이전에 올린 소스와 분석 결과(IR)를 그대로 써서 빌드부터 다시 배포한다. ZIP을 다시 올리지 않는다.
 * 서버가 새 배포를 만들어 주면 그 배포의 진행 화면으로 간다. 끝난 배포에서만 쓴다(진행 중이면 서버가 409로 거절).
 */
export function RedeployButton({ deploymentId, onStarted, variant = 'secondary', compact, onUploadAgain, mode = 'redeploy' }: {
  deploymentId: string; onStarted: (newDeploymentId: string) => void; variant?: 'primary' | 'secondary' | 'ghost'; /** 목록 행처럼 좁은 자리 */ compact?: boolean;
  /** 재배포를 시작하지 못했을 때만 보여 주는 대안: ZIP을 다시 올리러 간다 (분석 전에 실패한 배포는 재배포할 수 없다) */
  onUploadAgain?: () => void;
  /**
   * rollback: 지금 서비스 중인 버전보다 이전에 성공한 배포를 다시 배포해 그 버전으로 되돌린다 (#139).
   * 서버에는 같은 재배포 API를 쓴다. 서비스 중인 버전을 바꾸는 일이라 한 번 더 확인받는다.
   */
  mode?: 'redeploy' | 'rollback';
}) {
  const { t } = useI18n();
  const copy = mode === 'rollback' ? t.rollback : t.redeploy;
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function redeploy() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      onStarted((await redeployDeployment(deploymentId)).deploymentId);
    } catch (requestError) {
      setError(requestError);
      setBusy(false);
      setConfirming(false);
    }
  }

  // 서버가 준 사유(진행 중 · 분석 결과 없음 · 환경 사용 중)를 그대로 보여 준다. 없으면 일반 문구.
  const reason = error instanceof DeploymentApiError && error.serverMessage ? error.serverMessage : errorMessage(error, t, copy.failed);
  const label = `${copy.button} — ${t.dashboard.deploymentNo(deploymentId)}`;
  return <span className={`redeploy ${compact ? 'is-compact' : ''}`}>
    {mode === 'rollback' && confirming
      ? <span className="redeploy__confirm" role="group" aria-label={label}>
        <span>{t.rollback.confirm(t.dashboard.deploymentNo(deploymentId))}</span>
        <Keycap variant="secondary" sound="start" disabled={busy} onClick={() => void redeploy()}>{busy ? copy.starting : t.rollback.confirmYes}</Keycap>
        <Keycap variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{t.deploy.aws.cancel}</Keycap>
      </span>
      : <Keycap variant={variant} sound={mode === 'rollback' ? 'tap' : 'start'} disabled={busy} aria-label={label}
        onClick={() => { if (mode === 'rollback') { setError(null); setConfirming(true); } else void redeploy(); }}>{busy ? copy.starting : copy.button}</Keycap>}
    {error !== null && <span className="redeploy__error" role="alert"><strong>{copy.failed}</strong> {reason}</span>}
    {error !== null && onUploadAgain && <Keycap variant="secondary" onClick={onUploadAgain}>{t.redeploy.uploadAgain}</Keycap>}
  </span>;
}
