import { useId, useState, type FormEvent } from 'react';
import { Keycap } from '../../components/ui/Keycap';
import { AwsKeyRejectedError, DeploymentApiError } from '../../api/deployment-api';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';

/** aws-ecs-basic 프로필의 기본 리전이 첫 번째다 (packages/profiles). */
const regions = ['ap-northeast-2', 'ap-northeast-1', 'ap-northeast-3', 'us-east-1', 'us-west-2'] as const;

/**
 * AWS 키 등록 폼. 입력한 키는 서버 시크릿 저장소로만 보내고, 등록이 끝나면 화면 상태에서 지운다.
 * 브라우저 저장소 · 로그 · URL에는 남기지 않는다.
 */
export function AwsKeyForm({ onSubmit, initialRegion, onCancel, autoFocus }: {
  onSubmit: (input: { accessKeyId: string; secretAccessKey: string; region: string }) => Promise<void>;
  /** 키를 바꿀 때 — 지금 등록된 리전 */
  initialRegion?: string | null;
  onCancel?: () => void;
  /** 모달 안에서 열릴 때 첫 입력란에 바로 초점을 둔다 */
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [region, setRegion] = useState<string>(initialRegion ?? regions[0]);
  // 목록에 없는 리전으로 등록돼 있었다면 그 값도 고를 수 있게 한다.
  const regionOptions = initialRegion && !(regions as readonly string[]).includes(initialRegion) ? [initialRegion, ...regions] : regions;
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

  function awsKeyErrorText(value: unknown): string {
    if (value instanceof AwsKeyRejectedError) return t.deploy.aws.rejected[value.reason];
    if (value instanceof DeploymentApiError && value.code === 'AWS_VERIFY_UNAVAILABLE') return t.deploy.aws.verifyUnavailable;
    return errorMessage(value, t, t.deploy.aws.saveError);
  }

  return <form className="aws-key-form" onSubmit={(event) => void submit(event)} autoComplete="off">
    <div className="aws-key-form__field">
      <label htmlFor={ids.key}>{t.deploy.aws.accessKeyId}</label>
      <input id={ids.key} name="aws-access-key-id" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} required autoFocus={autoFocus} autoComplete="off" spellCheck={false} disabled={saving} />
    </div>
    <div className="aws-key-form__field">
      <label htmlFor={ids.secret}>{t.deploy.aws.secretAccessKey}</label>
      <input id={ids.secret} name="aws-secret-access-key" type="password" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} required autoComplete="new-password" spellCheck={false} disabled={saving} />
    </div>
    <div className="aws-key-form__field">
      <label htmlFor={ids.region}>{t.deploy.aws.region}</label>
      <select id={ids.region} value={region} onChange={(event) => setRegion(event.target.value)} disabled={saving}>
        {regionOptions.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
    </div>
    <p className="aws-key-form__note">{t.deploy.aws.note}</p>
    {error !== null && <div className="notice error" role="alert"><strong>{t.deploy.aws.saveError}</strong><br />{awsKeyErrorText(error)}</div>}
    <div className="aws-key-form__actions">
      <Keycap type="submit" variant="secondary" disabled={saving || !accessKeyId.trim() || !secretAccessKey.trim()}>{saving ? t.deploy.aws.saving : t.deploy.aws.save}</Keycap>
      {onCancel && <Keycap variant="ghost" onClick={onCancel} disabled={saving}>{t.deploy.aws.cancel}</Keycap>}
    </div>
  </form>;
}
