import type { CSSProperties } from 'react';
import { useI18n } from '../../i18n/I18nProvider';

/** POST /deployments 의 target — 벤더까지만 고른다. 프로필은 서버가 벤더에서 정한다 (packages/contracts TARGET_VENDORS). */
export const deployTargets = ['aws', 'onprem'] as const;
export type DeployTarget = typeof deployTargets[number];

export function isDeployTarget(value: unknown): value is DeployTarget { return (deployTargets as readonly unknown[]).includes(value); }

/** 배포할 곳 선택. 기본값이 골라져 있어서 누르지 않아도 배포할 수 있다 (원클릭 유지). */
export function TargetToggle({ value, onChange, disabled, name = 'deploy-target', legend }: { value: DeployTarget; onChange: (next: DeployTarget) => void; disabled?: boolean; /** 한 화면에 둘이 있을 때 라디오 묶음이 섞이지 않게 하는 이름 */ name?: string; /** 기본 제목(배포할 곳) 대신 쓸 제목 */ legend?: string }) {
  const { t } = useI18n();
  return <fieldset className="target-toggle" disabled={disabled}>
    <legend>{legend ?? t.deploy.targetLabel}</legend>
    <div className="target-toggle__options" style={{ '--selected': deployTargets.indexOf(value) } as CSSProperties}>
      <span className="target-toggle__thumb" aria-hidden="true" />
      {deployTargets.map((target) => <label key={target} className="target-toggle__option">
        <input type="radio" name={name} value={target} checked={value === target} onChange={() => onChange(target)} />
        <span>{t.deploy.targets[target]}</span>
      </label>)}
    </div>
  </fieldset>;
}
