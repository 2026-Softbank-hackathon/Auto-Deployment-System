import { useEffect, useId, useRef } from 'react';
import type { EnvironmentSummary } from '../../api/deployment-api';
import { followAppLink, type Navigate } from '../../app/navigation';
import { Keycap } from '../../components/ui/Keycap';
import { useI18n } from '../../i18n/I18nProvider';
import { EnvironmentIcon } from './DeploymentRow';

/** 연결 등록 · 관리 화면 */
export const CONNECTIONS_PATH = '/connections';

/** Agent가 연락하지 않는 온프레미스 연결에는 배포할 수 없다. 서버가 상태를 주지 않으면(모르면) 막지 않는다. */
export function isOffline(environment: EnvironmentSummary): boolean {
  return environment.type === 'onprem' && environment.agentOnline === false;
}

/**
 * "다른 환경으로 배포"에서 배포할 곳을 고르는 모달 (#220). 원래 배포와 종류가 다른 연결만 받아서 보여 준다.
 * 고르면 바로 시작한다(한 번 더 묻지 않는다). 시작하는 동안은 다시 고를 수 없다. Agent가 꺼진 온프레미스 연결은 이유와 함께 막는다.
 */
export function EnvironmentChooser({ open, sourceName, environments, starting, onChoose, onClose, onNavigate }: {
  open: boolean; /** "앱 이름 배포 #12" */ sourceName: string; environments: EnvironmentSummary[];
  starting: boolean; onChoose: (environment: EnvironmentSummary) => void; onClose: () => void; onNavigate: Navigate;
}) {
  const { t } = useI18n();
  const copy = t.versions;
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return <dialog ref={dialog} className="picker-dialog" aria-labelledby={titleId} onClose={onClose}
    onClick={(event) => { if (event.target === dialog.current) onClose(); }}>
    <div className="picker-dialog__body">
      <div className="picker-dialog__head">
        <h2 id={titleId}>{copy.switchEnv}</h2>
        <button type="button" className="toast__close" aria-label={copy.close} onClick={onClose}>×</button>
      </div>
      <p>{copy.switchDescription(sourceName)}</p>
      <ul className="picker-list">
        {environments.map((environment) => {
          const offline = isOffline(environment);
          const detail = [t.deploy.targets[environment.type], environment.type === 'aws' ? environment.region : environment.hostname,
            environment.shared ? copy.shared : null, environment.isDefault ? copy.isDefault : null].filter(Boolean).join(' · ');
          return <li key={environment.id}>
            <button type="button" className="picker-list__item" disabled={starting || offline} onClick={() => onChoose(environment)}>
              <strong className="picker-list__env"><EnvironmentIcon type={environment.type} />{environment.name || t.deploy.targets[environment.type]}</strong>
              <span>{detail}</span>
              {offline && <span className="picker-list__reason">{copy.agentOffline}</span>}
            </button>
          </li>;
        })}
      </ul>
      {starting && <p role="status">{copy.switchStarting}</p>}
      <div className="picker-dialog__actions">
        <a className="setup-summary__link" href={CONNECTIONS_PATH} onClick={(event) => { onClose(); followAppLink(event, onNavigate); }}>{copy.goConnections}</a>
        <Keycap variant="ghost" onClick={onClose}>{copy.close}</Keycap>
      </div>
    </div>
  </dialog>;
}
