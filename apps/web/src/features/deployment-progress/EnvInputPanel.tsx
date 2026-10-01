import { useId, useState, type FormEvent } from 'react';
import { DeploymentApiError, patchProjectEnv } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { looksSecret } from '../setup/env-plan';

const VALUE_MAX = 4096;

/**
 * 배포 전 환경변수 입력 (#142, #150): 분석이 끝난 뒤, 기본값도 자동 값도 없어 등록해야만 배포되는 변수를 그 자리에서 받는다.
 * 저장하면 프로젝트 환경변수로 등록되고(다음 배포에도 쓰인다) 배포가 이어진다. 값을 대신 지어내지 않는다.
 */
export function EnvInputPanel({ projectId, names, onSaved }: { projectId: string; names: string[]; /** 저장이 끝나 배포를 이어 가도 될 때 */ onSaved: () => void }) {
  const { t } = useI18n();
  const copy = t.run.envInput;
  const baseId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const complete = names.every((name) => (values[name] ?? '') !== '');
  const secretNames = names.filter(looksSecret);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!complete || saving) return;
    setSaving(true);
    setError(null);
    try {
      await patchProjectEnv(projectId, Object.fromEntries(names.map((name) => [name, values[name] ?? ''])));
      onSaved();
    } catch (requestError) {
      setError(requestError);
      setSaving(false);
    }
  }

  return <form className="notice env-input" onSubmit={(event) => void submit(event)} autoComplete="off" aria-labelledby={`${baseId}-title`}>
    <strong id={`${baseId}-title`}>{copy.title(names.length)}</strong>
    <p>{copy.copy}</p>
    <div className="env-input__fields">
      {names.map((name, index) => <div key={name} className="aws-key-form__field">
        <label htmlFor={`${baseId}-${index}`}><code>{name}</code></label>
        <input id={`${baseId}-${index}`} value={values[name] ?? ''} onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
          maxLength={VALUE_MAX} required autoFocus={index === 0} autoComplete="off" spellCheck={false} disabled={saving} />
      </div>)}
    </div>
    {secretNames.length > 0 && <p className="env-warning">{t.setup.env.secretWarning(secretNames.join(', '))}</p>}
    {error !== null && <div className="notice error" role="alert"><strong>{t.setup.env.saveError}</strong><br />
      {error instanceof DeploymentApiError && error.serverMessage ? error.serverMessage : errorMessage(error, t, t.setup.env.saveError)}</div>}
    <div><Keycap type="submit" sound="start" disabled={!complete || saving}>{saving ? t.deploy.aws.saving : copy.submit}</Keycap></div>
  </form>;
}
