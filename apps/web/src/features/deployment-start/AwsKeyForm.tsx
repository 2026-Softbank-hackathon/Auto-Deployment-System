import { useId, useState, type FormEvent } from 'react';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';

/** aws-ecs-basic 프로필의 기본 리전이 첫 번째다 (packages/profiles). */
const regions = ['ap-northeast-2', 'ap-northeast-1', 'ap-northeast-3', 'us-east-1', 'us-west-2'] as const;

/**
 * AWS 키 등록 폼. 입력한 키는 서버 시크릿 저장소로만 보내고, 등록이 끝나면 화면 상태에서 지운다.
 * 브라우저 저장소 · 로그 · URL에는 남기지 않는다.
 */
export function AwsKeyForm({ onSubmit }: { onSubmit: (input: { accessKeyId: string; secretAccessKey: string; region: string }) => Promise<void> }) {
  const { t } = useI18n();
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [region, setRegion] = useState<string>(regions[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ids = { key: useId(), secret: useId(), region: useId() };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ accessKeyId: accessKeyId.trim(), secretAccessKey: secretAccessKey.trim(), region });
      setAccessKeyId('');
      setSecretAccessKey('');
    } catch (requestError) {
      setError(requestError);
    } finally {
      setSaving(false);
    }
  }

  return <form className="aws-key-form" onSubmit={(event) => void submit(event)} autoComplete="off">
    <div className="aws-key-form__field">
      <label htmlFor={ids.key}>{t.deploy.aws.accessKeyId}</label>
      <input id={ids.key} name="aws-access-key-id" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} required autoComplete="off" spellCheck={false} disabled={saving} />
    </div>
    <div className="aws-key-form__field">
      <label htmlFor={ids.secret}>{t.deploy.aws.secretAccessKey}</label>
      <input id={ids.secret} name="aws-secret-access-key" type="password" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} required autoComplete="new-password" spellCheck={false} disabled={saving} />
    </div>
    <div className="aws-key-form__field">
      <label htmlFor={ids.region}>{t.deploy.aws.region}</label>
      <select id={ids.region} value={region} onChange={(event) => setRegion(event.target.value)} disabled={saving}>
        {regions.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    </div>
    <p className="aws-key-form__note">{t.deploy.aws.note}</p>
    {error !== null && <div className="notice error" role="alert"><strong>{t.deploy.aws.saveError}</strong><br />{errorMessage(error, t, t.deploy.aws.saveError)}</div>}
    <Keycap type="submit" variant="secondary" disabled={saving || !accessKeyId.trim() || !secretAccessKey.trim()}>{saving ? t.deploy.aws.saving : t.deploy.aws.save}</Keycap>
  </form>;
}
