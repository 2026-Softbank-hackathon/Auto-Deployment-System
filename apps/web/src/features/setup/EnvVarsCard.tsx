import { useEffect, useId, useState, type FormEvent } from 'react';
import { DeploymentApiError, listProjectEnv, patchProjectEnv, type ProjectEnvVar } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { requiredEnvOfProject, type RequiredEnvVar } from './required-env';

/** 서버 계약과 같은 이름 규칙 (packages/contracts env.ts). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_MAX = 128;
const VALUE_MAX = 4096;

/**
 * DAT-01 프로젝트 환경변수. 평문 설정값이라 값을 그대로 보여 주고, 바꾼 값은 다음 배포부터 적용된다.
 * 비밀 값(키 · 비밀번호)은 여기에 넣지 않는다.
 */
export function EnvVarsCard({ projectId }: { projectId: string | null }) {
  const { t } = useI18n();
  const copy = t.setup.env;
  const ids = { name: useId(), value: useId() };
  const [items, setItems] = useState<ProjectEnvVar[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  // 최근 배포의 분석이 찾은 "앱이 읽는 변수". 값을 대신 넣지는 않고, 무엇을 등록해야 하는지만 알려 준다.
  const [required, setRequired] = useState<RequiredEnvVar[]>([]);

  useEffect(() => {
    if (!projectId) return;
    let active = true;
    setItems(null);
    setLoadError(null);
    listProjectEnv(projectId).then((list) => { if (active) setItems(list); }, (error) => { if (active) setLoadError(error); });
    setRequired([]);
    requiredEnvOfProject(projectId).then((list) => { if (active) setRequired(list); }, () => { /* 안내용이라 읽지 못해도 카드는 동작한다 */ });
    return () => { active = false; };
  }, [projectId]);

  if (!projectId) return <p>{t.setup.needsApp}</p>;

  const trimmedName = name.trim();
  const nameInvalid = trimmedName !== '' && !ENV_NAME.test(trimmedName);
  const overwrites = items?.some((item) => item.name === trimmedName) ?? false;
  const missing = items === null ? [] : required.filter((variable) => !items.some((item) => item.name === variable.name));

  async function apply(vars: Record<string, string | null>) {
    if (!projectId || saving) return false;
    setSaving(true);
    setSaveError(null);
    try { setItems(await patchProjectEnv(projectId, vars)); return true; } catch (error) { setSaveError(error); return false; } finally { setSaving(false); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmedName || nameInvalid) return;
    if (await apply({ [trimmedName]: value })) { setName(''); setValue(''); }
  }

  return <>
    <p>{copy.copy}</p>
    {loadError !== null && <div className="notice error" role="alert">{errorMessage(loadError, t, copy.loadError)}</div>}
    {items === null && loadError === null && <p role="status">{copy.loading}</p>}
    {items !== null && items.length === 0 && <p>{copy.empty}</p>}
    {items !== null && items.length > 0 && <ul className="env-list" aria-label={copy.listLabel}>
      {items.map((item) => <li key={item.name}>
        <code className="env-list__name">{item.name}</code>
        <code className="env-list__value">{item.value === '' ? copy.emptyValue : item.value}</code>
        <span className="env-list__actions">
          <Keycap variant="ghost" disabled={saving} onClick={() => { setName(item.name); setValue(item.value); }} aria-label={copy.editLabel(item.name)}>{copy.edit}</Keycap>
          <Keycap variant="ghost" disabled={saving} onClick={() => void apply({ [item.name]: null })} aria-label={copy.removeLabel(item.name)}>{copy.remove}</Keycap>
        </span>
      </li>)}
    </ul>}
    {missing.length > 0 && <div className="notice env-missing">
      <strong>{copy.missingTitle(missing.length)}</strong>
      <p>{copy.missingCopy}</p>
      <div className="env-missing__names">
        {missing.map((variable) => <button key={variable.name} type="button" className="env-missing__name" disabled={saving}
          onClick={() => { setName(variable.name); setValue(variable.suggestedValue ?? ''); document.getElementById(ids.value)?.focus(); }}>{variable.name}</button>)}
      </div>
    </div>}
    <form className="aws-key-form" onSubmit={(event) => void submit(event)} autoComplete="off">
      <div className="aws-key-form__field">
        <label htmlFor={ids.name}>{copy.name}</label>
        <input id={ids.name} value={name} onChange={(event) => setName(event.target.value)} maxLength={NAME_MAX} placeholder="APP_MESSAGE" autoComplete="off" spellCheck={false} disabled={saving} aria-invalid={nameInvalid} />
      </div>
      <div className="aws-key-form__field">
        <label htmlFor={ids.value}>{copy.value}</label>
        <input id={ids.value} value={value} onChange={(event) => setValue(event.target.value)} maxLength={VALUE_MAX} autoComplete="off" spellCheck={false} disabled={saving} />
      </div>
      <p className="aws-key-form__note">{nameInvalid ? copy.nameInvalid : overwrites ? copy.overwrites : copy.note}</p>
      {saveError !== null && <div className="notice error" role="alert"><strong>{copy.saveError}</strong><br />
        {saveError instanceof DeploymentApiError && saveError.serverMessage ? saveError.serverMessage : errorMessage(saveError, t, copy.saveError)}</div>}
      <div className="aws-key-form__actions">
        <Keycap type="submit" variant="secondary" disabled={saving || !trimmedName || nameInvalid}>{saving ? t.deploy.aws.saving : overwrites ? copy.update : copy.add}</Keycap>
      </div>
    </form>
  </>;
}
