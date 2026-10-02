import { useState } from 'react';
import { cancelDeployment } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { useI18n } from '../../i18n/I18nProvider';
import { ServerReason } from './ServerReason';

/**
 * 진행 중인 배포 취소. 되돌릴 수 없어서 한 번 더 확인받는다.
 * 취소하면 서버가 상태를 cancelled로 바꾸고 환경 락을 풀어 준다. 끝나면 onCancelled로 화면이 상태를 다시 읽게 한다.
 */
export function CancelDeployment({ deploymentId, onCancelled }: { deploymentId: string; onCancelled: () => void }) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function cancel() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancelDeployment(deploymentId);
      onCancelled();
    } catch (requestError) {
      setError(requestError);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  return <div className="run-cancel">
    {confirming
      ? <div className="run-cancel__confirm" role="group" aria-label={t.cancel.button}>
        <span>{t.cancel.confirm(t.dashboard.deploymentNo(deploymentId))}</span>
        <Keycap variant="secondary" disabled={busy} onClick={() => void cancel()}>{busy ? t.cancel.cancelling : t.cancel.button}</Keycap>
        <Keycap variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{t.cancel.keep}</Keycap>
      </div>
      : <Keycap variant="ghost" onClick={() => { setError(null); setConfirming(true); }}>{t.cancel.button}</Keycap>}
    {error !== null && <div className="run-cancel__error" role="alert"><strong>{t.cancel.failed}</strong> <ServerReason error={error} fallback={t.cancel.failed} /></div>}
  </div>;
}
