import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { DeploymentApiError, type EnvironmentSummary } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { Koro } from '../../components/ui/Koro';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { displayProjectName } from '../dashboard/format';
import { AwsKeyForm } from './AwsKeyForm';
import type { DeployProject } from './useDeployProject';

type Step = 'name' | 'aws' | 'done';
const steps: readonly Step[] = ['name', 'aws', 'done'];
const NAME_MAX = 100;

type AwsInput = { accessKeyId: string; secretAccessKey: string; region: string };

/**
 * 처음 한 번 하는 프로젝트 설정: ① 앱 이름 → ② AWS 연결 → ③ 완료.
 * 설정이 끝나면 다음 배포부터는 ZIP만 올리면 된다. 이미 설정한 뒤에 열면 AWS 키만 바꾼다.
 * 열 때마다 새로 시작하도록 부모가 key를 바꿔 다시 만든다.
 */
export function SetupDialog({ project, awsEnvironment, onCreateProject, onRegisterAws, onClose }: {
  project: DeployProject | null;
  awsEnvironment: EnvironmentSummary | null;
  onCreateProject: (name: string) => Promise<void>;
  onRegisterAws: (input: AwsInput) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const nameId = useId();
  // 열린 시점의 상태로 모드를 고정한다 (등록이 끝나 props가 바뀌어도 안내 순서가 흔들리지 않게).
  const [changeOnly] = useState(awsEnvironment !== null);
  const [step, setStep] = useState<Step>(project ? 'aws' : 'name');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<unknown>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
    // showModal은 첫 번째 버튼(닫기)에 초점을 두므로, 입력란으로 옮긴다.
    dialog.querySelector('input')?.focus();
  }, []);

  async function submitName(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setNameError(null);
    try {
      await onCreateProject(trimmed);
      setStep('aws');
    } catch (requestError) {
      setNameError(requestError);
    } finally {
      setSaving(false);
    }
  }

  async function submitAws(input: AwsInput) {
    await onRegisterAws(input);
    if (changeOnly) onClose(); else setStep('done');
  }

  const title = changeOnly ? t.deploy.aws.changeTitle : t.deploy.setup.title;
  return <dialog ref={dialogRef} className="setup-dialog" aria-labelledby={titleId} onClose={onClose}
    onCancel={(event) => { if (saving) event.preventDefault(); }}>
    <div className="setup-dialog__head">
      <Koro mood={step === 'done' ? 'happy' : 'normal'} size={44} />
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="setup-dialog__close" aria-label={t.deploy.setup.close} onClick={() => dialogRef.current?.close()} disabled={saving}>×</button>
    </div>

    {!changeOnly && <ol className="setup-steps" aria-label={t.deploy.setup.stepsLabel}>
      {steps.map((item, index) => {
        const state = steps.indexOf(step) > index ? 'done' : step === item ? 'current' : 'pending';
        return <li key={item} className={`setup-steps__item is-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
          <span className="setup-steps__no" aria-hidden="true">{state === 'done' ? '✓' : index + 1}</span>{t.deploy.setup.steps[item]}
        </li>;
      })}
    </ol>}

    {step === 'name' && <form className="setup-dialog__body" onSubmit={(event) => void submitName(event)} autoComplete="off">
      <h3>{t.deploy.setup.nameQuestion}</h3>
      <p>{t.deploy.setup.nameCopy}</p>
      <div className="aws-key-form__field">
        <label htmlFor={nameId}>{t.deploy.setup.nameLabel}</label>
        <input id={nameId} value={name} onChange={(event) => setName(event.target.value)} maxLength={NAME_MAX} required autoFocus autoComplete="off" spellCheck={false} disabled={saving} />
      </div>
      {nameError !== null && <div className="notice error" role="alert">
        {nameError instanceof DeploymentApiError && nameError.status === 409 ? t.deploy.setup.nameTaken : errorMessage(nameError, t, t.deploy.setup.nameError)}
      </div>}
      <div className="setup-dialog__actions">
        <Keycap type="submit" disabled={saving || !name.trim()}>{saving ? t.deploy.aws.saving : t.deploy.setup.next}</Keycap>
      </div>
    </form>}

    {step === 'aws' && <div className="setup-dialog__body">
      {!changeOnly && <h3>{t.deploy.setup.awsQuestion}</h3>}
      <p>{changeOnly ? t.deploy.aws.changeCopy : t.deploy.setup.awsCopy}</p>
      {project && <p className="setup-dialog__app">{t.deploy.setup.appLine(displayProjectName(project.name))}</p>}
      <AwsKeyForm autoFocus initialRegion={awsEnvironment?.region} onSubmit={submitAws} onCancel={changeOnly ? () => dialogRef.current?.close() : undefined} />
    </div>}

    {step === 'done' && <div className="setup-dialog__body">
      <h3>{t.deploy.setup.doneTitle}</h3>
      <p>{t.deploy.setup.doneCopy}</p>
      <div className="setup-dialog__actions">
        <Keycap onClick={() => dialogRef.current?.close()}>{t.deploy.setup.start}</Keycap>
      </div>
    </div>}
  </dialog>;
}
