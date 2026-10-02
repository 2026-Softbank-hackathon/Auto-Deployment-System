import { useId, useState, type FormEvent } from 'react';
import { patchDeploymentIr, patchProjectEnv } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { useI18n } from '../../i18n/I18nProvider';
import { ServerReason } from './ServerReason';
import { looksSecret } from '../setup/env-plan';

const VALUE_MAX = 4096;

/** 분석이 찾은 서비스의 포트. 찾지 못했으면 null. */
export interface DetectedPort { service: string; port: number | null }

/** 배포를 이어 가기 전에 사용자에게 받을 것. */
export interface PreDeployReview {
  /** 등록해야만 배포되는 환경변수 이름 (서버의 missingEnvNames) */
  envNames: string[];
  /** 서비스별 감지된 포트 */
  ports: DetectedPort[];
  /** IR 버전 (포트를 고칠 때 낙관적 잠금에 쓴다) */
  irVersion: number | null;
}

function validPort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * 배포 전 확인 (#142, #144, #150): 분석이 끝난 뒤 대상 승인 전에 멈춰서
 * 감지한 포트를 고치고(#144), 등록해야만 배포되는 환경변수를 받는다(#142).
 * 포트는 서버가 이 상태(awaiting_target_confirmation)에서만 수정을 받아 준다.
 * 값을 대신 지어내지 않는다. 포트는 감지한 값을 미리 채워 두고, 환경변수는 빈 칸으로 둔다.
 */
export function PreDeployPanel({ deploymentId, projectId, review, onDone }: { deploymentId: string; projectId: string; review: PreDeployReview; /** 저장이 끝나 배포를 이어 가도 될 때 */ onDone: () => void }) {
  const { t } = useI18n();
  const copy = t.run.review;
  const baseId = useId();
  const [ports, setPorts] = useState<Record<string, string>>(() => Object.fromEntries(review.ports.map((item) => [item.service, item.port === null ? '' : String(item.port)])));
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const portsValid = review.ports.every((item) => validPort(ports[item.service] ?? '') !== null);
  const envComplete = review.envNames.every((name) => (values[name] ?? '') !== '');
  const changedPorts = review.ports.filter((item) => validPort(ports[item.service] ?? '') !== item.port);
  const secretNames = review.envNames.filter(looksSecret);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!portsValid || !envComplete || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (changedPorts.length > 0 && review.irVersion !== null) {
        await patchDeploymentIr(deploymentId, { services: Object.fromEntries(changedPorts.map((item) => [item.service, { port: validPort(ports[item.service] ?? '') }])) }, review.irVersion);
      }
      if (review.envNames.length > 0) await patchProjectEnv(projectId, Object.fromEntries(review.envNames.map((name) => [name, values[name] ?? ''])));
      onDone();
    } catch (requestError) {
      setError(requestError);
      setSaving(false);
    }
  }

  return <form className="notice env-input" onSubmit={(event) => void submit(event)} autoComplete="off" aria-labelledby={`${baseId}-title`}>
    <strong id={`${baseId}-title`}>{copy.title}</strong>

    {review.ports.length > 0 && <div className="env-input__group">
      <p>{review.ports.some((item) => item.port === null) ? copy.portMissing : copy.portCopy}</p>
      <div className="env-input__fields">
        {review.ports.map((item, index) => {
          const text = ports[item.service] ?? '';
          const invalid = validPort(text) === null;
          return <div key={item.service} className="aws-key-form__field">
            <label htmlFor={`${baseId}-port-${index}`}>{copy.portLabel(item.service)}</label>
            <input id={`${baseId}-port-${index}`} inputMode="numeric" value={text} onChange={(event) => setPorts((current) => ({ ...current, [item.service]: event.target.value.trim() }))}
              maxLength={5} required autoComplete="off" disabled={saving} aria-invalid={invalid} />
            {invalid && text !== '' && <span className="env-warning">{copy.portInvalid}</span>}
          </div>;
        })}
      </div>
    </div>}

    {review.envNames.length > 0 && <div className="env-input__group">
      <p>{copy.envCopy(review.envNames.length)}</p>
      <div className="env-input__fields">
        {review.envNames.map((name, index) => <div key={name} className="aws-key-form__field">
          <label htmlFor={`${baseId}-env-${index}`}><code>{name}</code></label>
          <input id={`${baseId}-env-${index}`} value={values[name] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
            maxLength={VALUE_MAX} required autoComplete="off" spellCheck={false} disabled={saving} />
        </div>)}
      </div>
      {secretNames.length > 0 && <p className="env-warning">{t.setup.env.secretWarning(secretNames.join(', '))}</p>}
    </div>}

    {error !== null && <div className="notice error" role="alert"><strong>{copy.saveError}</strong><br />
      <ServerReason error={error} fallback={copy.saveError} /></div>}
    <div><Keycap type="submit" sound="start" disabled={!portsValid || !envComplete || saving}>{saving ? t.deploy.aws.saving : copy.submit}</Keycap></div>
  </form>;
}
