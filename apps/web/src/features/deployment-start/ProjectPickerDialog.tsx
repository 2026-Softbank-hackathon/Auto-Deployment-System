import { useEffect, useId, useRef, useState } from 'react';
import { listEnvironments, listSecretNames } from '../../api/deployment-api';
import { followAppLink, type Navigate } from '../../app/navigation';
import { Keycap } from '../../components/ui/Keycap';
import { useI18n } from '../../i18n/I18nProvider';
import { displayProjectName } from '../dashboard/format';
import { awsKeysMissing, type DeployProject } from './useDeployProject';

/** 배포할 수 있는 프로젝트 한 개 (AWS 연결이 준비된 것). */
export interface ReadyProject extends DeployProject { region: string | null; onpremHost: string | null }

/**
 * 프로젝트마다 필수 연결(AWS)이 준비됐는지 확인해 배포할 수 있는 것만 고른다.
 * AWS는 어느 대상이든 필요하다(온프레미스도 이미지를 사용자 ECR에 둔다). 확인하지 못한 프로젝트는 넣지 않는다.
 * 프로젝트별 상태를 한 번에 주는 API가 없어 프로젝트마다 환경 · 시크릿 목록을 읽는다.
 */
export function useReadyProjects(projects: DeployProject[] | null): ReadyProject[] | null {
  const [ready, setReady] = useState<ReadyProject[] | null>(null);
  const key = projects ? projects.map((project) => project.id).join(',') : null;
  useEffect(() => {
    if (!projects) { setReady(null); return; }
    let active = true;
    void Promise.all(projects.map(async (project): Promise<ReadyProject | null> => {
      try {
        const [environments, secretNames] = await Promise.all([listEnvironments(project.id), listSecretNames(project.id).catch(() => null)]);
        const defaultOf = (type: 'aws' | 'onprem') => environments.find((environment) => environment.type === type && environment.isDefault) ?? null;
        const aws = defaultOf('aws');
        if (!aws || awsKeysMissing(environments, secretNames)) return null;
        return { ...project, region: aws.region, onpremHost: defaultOf('onprem')?.hostname ?? null };
      } catch { return null; }
    })).then((results) => { if (active) setReady(results.filter((item): item is ReadyProject => item !== null)); });
    return () => { active = false; };
    // 프로젝트 목록이 바뀔 때만 다시 확인한다 (key가 목록을 대표한다).
  }, [key]);
  return ready;
}

/**
 * 배포할 프로젝트를 고르는 모달. 필수 연결이 끝난 프로젝트만 보여 주고, 빠진 프로젝트가 있으면 개수와 관리 화면 링크를 알려 준다.
 */
export function ProjectPickerDialog({ open, ready, hiddenCount, selectedId, onSelect, onClose, onNavigate }: {
  open: boolean; ready: ReadyProject[] | null; /** 연결이 없어 목록에서 뺀 프로젝트 수 */ hiddenCount: number; selectedId: string | null;
  onSelect: (projectId: string) => void; onClose: () => void; onNavigate: Navigate;
}) {
  const { t } = useI18n();
  const copy = t.deploy.picker;
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
        <h2 id={titleId}>{copy.title}</h2>
        <button type="button" className="toast__close" aria-label={copy.close} onClick={onClose}>×</button>
      </div>
      {ready === null && <p role="status">{copy.loading}</p>}
      {ready !== null && ready.length === 0 && <p>{copy.empty}</p>}
      {ready !== null && ready.length > 0 && <ul className="picker-list">
        {ready.map((project) => <li key={project.id}>
          <button type="button" className="picker-list__item" aria-current={project.id === selectedId ? 'true' : undefined} onClick={() => onSelect(project.id)}>
            <strong>{displayProjectName(project.name)}</strong>
            <span>AWS{project.region ? ` · ${project.region}` : ''}{project.onpremHost ? ` · ${t.deploy.targets.onprem} ${project.onpremHost}` : ''}</span>
            {project.id === selectedId && <span className="picker-list__current">{t.projects.selected}</span>}
          </button>
        </li>)}
      </ul>}
      {hiddenCount > 0 && <p className="picker-dialog__note">{copy.hidden(hiddenCount)}</p>}
      <div className="picker-dialog__actions">
        <a className="setup-summary__link" href="/projects" onClick={(event) => followAppLink(event, onNavigate)}>{copy.manage}</a>
        <Keycap variant="ghost" onClick={onClose}>{copy.close}</Keycap>
      </div>
    </div>
  </dialog>;
}
