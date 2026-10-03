import { useCallback, useEffect, useState } from 'react';
import { getDeploymentDiagnosis, type DeploymentDiagnosisResponse } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { useI18n } from '../../i18n/I18nProvider';

const POLL_MS = 4000;
const MAX_TRIES = 15;

/**
 * 실패한 배포의 AI 진단 (API-36). 서버가 실패 직후 진단 작업을 돌리므로 결과가 올 때까지 잠시 다시 조회한다.
 * 요약 · 수정 후보는 AI 가 한국어 · 일본어로 함께 쓴 문구 중 현재 언어 쪽을 보여 주고(#147), 수정 후보는 제안일 뿐 자동으로 적용하지 않는다.
 */
export function FailureDiagnosis({ deploymentId }: { deploymentId: string }) {
  const { t, language } = useI18n();
  const [diagnosis, setDiagnosis] = useState<DeploymentDiagnosisResponse | null>(null);
  const [waiting, setWaiting] = useState(true);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let active = true;
    let tries = 0;
    let timer: number | undefined;
    const load = async () => {
      tries += 1;
      const next = await getDeploymentDiagnosis(deploymentId).catch(() => null);
      if (!active) return;
      if (next) { setDiagnosis(next); setWaiting(false); return; }
      if (tries >= MAX_TRIES) { setWaiting(false); return; }
      timer = window.setTimeout(() => void load(), POLL_MS);
    };
    void load();
    return () => { active = false; window.clearTimeout(timer); };
  }, [deploymentId, round]);

  const retry = useCallback(() => { setWaiting(true); setRound((value) => value + 1); }, []);

  // 요약도 수정 후보도 비어 있는 진단은 없는 것으로 본다 (제목만 남지 않게)
  const empty = diagnosis !== null && !diagnosis.summary[language].trim() && diagnosis.patchCandidates.length === 0;
  if (!diagnosis || empty) {
    return <div className="diagnosis" aria-live="polite">
      <strong>{t.run.diagnosisTitle}</strong>
      <p>{waiting ? t.run.diagnosisLoading : t.run.diagnosisNone}</p>
      {!waiting && <Keycap variant="ghost" onClick={retry}>{t.run.diagnosisRetry}</Keycap>}
    </div>;
  }

  const step = diagnosis.failedStep ? (t.progress.logSteps as Record<string, string>)[diagnosis.failedStep] ?? diagnosis.failedStep : null;
  return <div className="diagnosis" aria-live="polite">
    <strong>{t.run.diagnosisTitle}</strong>
    {step && <p className="diagnosis__step">{t.run.diagnosisStep(step)}</p>}
    <p>{diagnosis.summary[language]}</p>
    {diagnosis.patchCandidates.length > 0 && <div className="diagnosis__patches">
      <p className="diagnosis__note">{t.run.diagnosisPatches(diagnosis.patchCandidates.length)}</p>
      {diagnosis.patchCandidates.map((candidate, index) => <details key={index} className="technical-details">
        <summary>{candidate.description[language]}</summary>
        <pre>{candidate.diff}</pre>
      </details>)}
    </div>}
  </div>;
}
