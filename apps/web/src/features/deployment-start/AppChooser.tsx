import { useId, type CSSProperties } from 'react';
import { followAppLink, type Navigate } from '../../app/navigation';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import { displayProjectName } from '../dashboard/format';
import { AddressField } from '../app-address/AddressField';
import type { SubdomainCheck } from '../app-address/subdomain';
import type { DeployProject } from './useDeployProject';

/** 서버 계약과 같은 길이 제한 (packages/contracts CreateProjectBodySchema) */
export const APP_NAME_MAX = 100;

export type AppChoice = { mode: 'new'; name: string } | { mode: 'existing'; projectId: string | null };

/** ZIP 파일 이름에서 앱 이름을 짓는다. GitHub에서 받은 ZIP의 -main / -master 꼬리는 뗀다. */
export function suggestAppName(fileName: string): string {
  return fileName.replace(/\.zip$/i, '').replace(/[-_ ](main|master)$/i, '').trim().replace(/\s+/g, '-').slice(0, APP_NAME_MAX);
}

/** 이름이 같은 기존 앱 (대소문자 무시, 예전에 자동으로 붙던 시각 꼬리는 떼고 비교) */
export function findAppByName(projects: DeployProject[] | null, name: string): DeployProject | null {
  const needle = name.trim().toLowerCase();
  if (!needle || !projects) return null;
  return projects.find((project) => project.name.toLowerCase() === needle || displayProjectName(project.name).toLowerCase() === needle) ?? null;
}

/**
 * 간단 배포의 "앱" 칸: 새 앱(이름은 ZIP 파일 이름으로 미리 채움) 또는 기존 앱 고르기.
 * 새 앱은 배포하기를 누를 때 만든다. 새 앱의 주소는 이름으로 추천하고 바꿀 수 있다 (#302).
 */
export function AppChooser({ projects, loadError, onRetry, value, onChange, address, envMissing, disabled, onNavigate }: {
  /** 기존 앱 목록. 읽는 중이면 null */
  projects: DeployProject[] | null; loadError: unknown; onRetry: () => void;
  value: AppChoice; onChange: (next: AppChoice, edited: 'mode' | 'name' | 'pick') => void;
  /** 새 앱의 주소 칸 */
  address: { value: string; onChange: (next: string) => void; check: SubdomainCheck };
  /** 고른 기존 앱에 등록이 필요한 환경변수 개수 */
  envMissing: number; disabled?: boolean; onNavigate: Navigate;
}) {
  const { t } = useI18n();
  const copy = t.deploy.app;
  const ids = { name: useId(), pick: useId(), radio: useId() };
  const modes = ['new', 'existing'] as const;
  const sameName = value.mode === 'new' ? findAppByName(projects, value.name) : null;
  const selected = value.mode === 'existing' && projects ? projects.find((project) => project.id === value.projectId) ?? null : null;

  function switchMode(mode: AppChoice['mode']) {
    if (mode === value.mode) return;
    onChange(mode === 'new' ? { mode: 'new', name: '' } : { mode: 'existing', projectId: projects?.[0]?.id ?? null }, 'mode');
  }

  return <div className="app-chooser">
    <fieldset className="target-toggle" disabled={disabled}>
      <legend>{copy.label}</legend>
      <div className="target-toggle__options" style={{ '--selected': modes.indexOf(value.mode) } as CSSProperties}>
        <span className="target-toggle__thumb" aria-hidden="true" />
        {modes.map((mode) => <label key={mode} className="target-toggle__option">
          <input type="radio" name={ids.radio} value={mode} checked={value.mode === mode} onChange={() => switchMode(mode)} />
          <span>{copy[mode]}</span>
        </label>)}
      </div>
    </fieldset>

    {value.mode === 'new' && <div className="app-chooser__field">
      <div className="aws-key-form__field">
        <label htmlFor={ids.name}>{copy.nameLabel}</label>
        <input id={ids.name} value={value.name} onChange={(event) => onChange({ mode: 'new', name: event.target.value }, 'name')} maxLength={APP_NAME_MAX}
          placeholder={copy.namePlaceholder} autoComplete="off" spellCheck={false} disabled={disabled} aria-describedby={`${ids.name}-hint`} />
      </div>
      <p id={`${ids.name}-hint`} className={`app-chooser__hint ${sameName ? 'is-missing' : ''}`} aria-live="polite">
        {sameName ? copy.nameTaken : copy.nameHint}
        {sameName && <> <button type="button" className="dashboard-tools__clear" disabled={disabled} onClick={() => onChange({ mode: 'existing', projectId: sameName.id }, 'pick')}>{copy.useExisting}</button></>}
      </p>
      {!sameName && <AddressField value={address.value} onChange={address.onChange} check={address.check} disabled={disabled}
        label={t.address.newLabel} emptyHint={t.address.newEmpty} unavailableHint={t.address.newFallback} />}
    </div>}

    {value.mode === 'existing' && <div className="app-chooser__field">
      {loadError !== null && projects === null
        ? <div className="notice error" role="alert"><strong>{copy.loadError}</strong><br />{errorMessage(loadError, t, copy.loadError)}
          <div><Keycap variant="ghost" onClick={onRetry}>{t.dashboard.retry}</Keycap></div></div>
        : projects === null ? <p className="app-chooser__hint" role="status">{copy.loading}</p>
          : projects.length === 0 ? <p className="app-chooser__hint">{copy.none}</p>
            : <div className="aws-key-form__field">
              <label htmlFor={ids.pick}>{copy.pickLabel}</label>
              <select id={ids.pick} value={selected?.id ?? ''} disabled={disabled} onChange={(event) => onChange({ mode: 'existing', projectId: event.target.value || null }, 'pick')}>
                {!selected && <option value="">{copy.pickPlaceholder}</option>}
                {projects.map((project) => <option key={project.id} value={project.id}>{displayProjectName(project.name)}</option>)}
              </select>
            </div>}
      {selected && envMissing > 0 && <a className="setup-summary__item is-missing" href={`/projects/${encodeURIComponent(selected.id)}/env`} onClick={(event) => followAppLink(event, onNavigate)}>{copy.envMissing(envMissing)}</a>}
    </div>}
  </div>;
}
