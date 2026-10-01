import { useId } from 'react';
import { useI18n } from '../../i18n/I18nProvider';
import { displayProjectName } from '../dashboard/format';
import type { DeployProject } from './useDeployProject';

/**
 * 배포할 앱(프로젝트)을 고르는 선택 상자. AWS 키 · 환경은 앱마다 따로 저장되므로
 * 앱을 바꾸면 연결 상태도 그 앱의 것으로 바뀐다.
 */
export function AppPicker({ projects, value, onChange, disabled, compact }: { projects: DeployProject[]; value: string | null; onChange: (projectId: string) => void; disabled?: boolean; /** 간단 배포의 한 줄 요약 안에 넣을 때 */ compact?: boolean }) {
  const { t } = useI18n();
  const selectId = useId();
  return <div className={compact ? 'app-picker is-compact' : 'app-picker aws-key-form__field'}>
    <label htmlFor={selectId}>{t.setup.app.pickLabel}</label>
    <select id={selectId} value={value ?? ''} disabled={disabled} onChange={(event) => { if (event.target.value) onChange(event.target.value); }}>
      {value === null && <option value="" disabled>{t.setup.app.pickPlaceholder}</option>}
      {projects.map((project) => <option key={project.id} value={project.id}>{displayProjectName(project.name)}</option>)}
    </select>
  </div>;
}
