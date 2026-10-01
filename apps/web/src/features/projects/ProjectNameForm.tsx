import { useId, useState, type FormEvent } from 'react';
import { DeploymentApiError } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';

const NAME_MAX = 100;

/** 새 프로젝트 이름 입력. 같은 이름이 있으면 서버가 409를 돌려준다. */
export function ProjectNameForm({ onCreate, onCancel }: { onCreate: (name: string) => Promise<void>; onCancel?: () => void }) {
  const { t } = useI18n();
  const nameId = useId();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try { await onCreate(trimmed); } catch (requestError) { setError(requestError); } finally { setSaving(false); }
  }

  return <>
    <form className="setup-form" onSubmit={(event) => void submit(event)} autoComplete="off">
      <div className="aws-key-form__field">
        <label htmlFor={nameId}>{t.setup.app.nameLabel}</label>
        <input id={nameId} value={name} onChange={(event) => setName(event.target.value)} maxLength={NAME_MAX} required autoComplete="off" spellCheck={false} disabled={saving} />
      </div>
      <Keycap type="submit" variant="secondary" disabled={saving || !name.trim()}>{saving ? t.deploy.aws.saving : t.setup.app.save}</Keycap>
      {onCancel && <Keycap variant="ghost" disabled={saving} onClick={onCancel}>{t.deploy.aws.cancel}</Keycap>}
    </form>
    {error !== null && <div className="notice error" role="alert">
      {error instanceof DeploymentApiError && error.status === 409 ? t.setup.app.nameTaken : errorMessage(error, t, t.setup.app.nameError)}
    </div>}
  </>;
}
