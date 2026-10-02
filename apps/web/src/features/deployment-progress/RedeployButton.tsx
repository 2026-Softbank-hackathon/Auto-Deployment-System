import { useState } from 'react';
import { redeployDeployment } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { redeployReasonText, useI18n } from '../../i18n/I18nProvider';

/**
 * 재배포 (#138): 이전에 올린 소스와 분석 결과(IR)를 그대로 써서 빌드부터 다시 배포한다. ZIP을 다시 올리지 않는다.
 * 서버가 새 배포를 만들어 주면 그 배포의 진행 화면으로 간다. 끝난 배포에서만 쓴다(진행 중이면 서버가 409로 거절).
 */
export function RedeployButton({ deploymentId, onStarted, variant = 'secondary', compact, onUploadAgain }: {
  deploymentId: string; onStarted: (newDeploymentId: string) => void; variant?: 'primary' | 'secondary' | 'ghost'; /** 목록 행처럼 좁은 자리 */ compact?: boolean;
  /** 재배포를 시작하지 못했을 때만 보여 주는 대안: ZIP을 다시 올리러 간다 (분석 전에 실패한 배포는 재배포할 수 없다) */
  onUploadAgain?: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
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
    }
  }

  // 서버가 거절한 사유(진행 중 · 분석 결과 없음 · 환경 사용 중)를 보여 준다. 모르는 사유는 서버 설명, 그것도 없으면 일반 문구.
  const reason = redeployReasonText(error, t, t.redeploy.failed);
  return <span className={`redeploy ${compact ? 'is-compact' : ''}`}>
    <Keycap variant={variant} sound="start" disabled={busy} onClick={() => void redeploy()} aria-label={`${t.redeploy.button} — ${t.dashboard.deploymentNo(deploymentId)}`}>{busy ? t.redeploy.starting : t.redeploy.button}</Keycap>
    {error !== null && <span className="redeploy__error" role="alert"><strong>{t.redeploy.failed}</strong> {reason}</span>}
    {error !== null && onUploadAgain && <Keycap variant="secondary" onClick={onUploadAgain}>{t.redeploy.uploadAgain}</Keycap>}
  </span>;
}
