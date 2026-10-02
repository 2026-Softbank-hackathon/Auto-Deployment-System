import { useEffect, useId, useState } from 'react';
import { decideDeploymentGate, DeploymentApiError, getDeploymentPatch, type DeploymentSourcePatch } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';

/** 승인 기록에 남기는 메모 — 사람이 직접 고른 결정이다 */
const DECISION_NOTE = { approve: 'patch approved by user (web)', reject: 'patch rejected by user (web): keep SQLite' } as const;

type DiffFile = { path: string; lines: string[] };

/** unified diff 를 파일별로 나눈다 ("--- " 다음 줄이 "+++ " 이면 새 파일) */
function splitDiff(diff: string): DiffFile[] {
  const lines = diff.split('\n');
  const files: DiffFile[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const next = lines[index + 1];
    if (line.startsWith('--- ') && next?.startsWith('+++ ')) {
      files.push({ path: next.slice(4).replace(/^b\//, ''), lines: [] });
      index++;
      continue;
    }
    if (line !== '' || index < lines.length - 1) files[files.length - 1]?.lines.push(line);
  }
  return files;
}

function lineClass(line: string): string {
  if (line.startsWith('@@')) return 'diff-line is-hunk';
  if (line.startsWith('+')) return 'diff-line is-add';
  if (line.startsWith('-')) return 'diff-line is-del';
  return 'diff-line';
}

/**
 * SQLite → PostgreSQL 코드 수정안 승인 (#277). 원클릭 흐름에서 사용자가 직접 고르는 유일한 확인이다.
 * 승인하면 수정된 소스로, 거절하면 원래 소스(SQLite 그대로)로 배포가 이어진다 — 어느 쪽이든 실패가 아니다.
 */
export function PatchApproval({ deploymentId, onDecided }: { deploymentId: string; onDecided: () => void }) {
  const { t, language } = useI18n();
  const copy = t.run.patch;
  const titleId = useId();
  const [patch, setPatch] = useState<DeploymentSourcePatch | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [deciding, setDeciding] = useState<'approve' | 'reject' | null>(null);
  const [decideError, setDecideError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    getDeploymentPatch(deploymentId).then((value) => { if (active) setPatch(value); }, (error: unknown) => { if (active) setLoadError(error); });
    return () => { active = false; };
  }, [deploymentId]);

  async function decide(decision: 'approve' | 'reject') {
    setDeciding(decision);
    setDecideError(null);
    try {
      await decideDeploymentGate(deploymentId, 'patch', decision, DECISION_NOTE[decision]);
      onDecided();
    } catch (error) {
      // 다른 탭에서 이미 결정했으면 정상으로 본다
      if (error instanceof DeploymentApiError && (error.code === 'APPROVAL_GATE_NOT_PENDING' || error.code === 'PATCH_NOT_PENDING')) { onDecided(); return; }
      setDecideError(error);
      setDeciding(null);
    }
  }

  const diffFiles = patch ? splitDiff(patch.diff) : [];
  return <section className="notice patch-approval" aria-labelledby={titleId}>
    <strong id={titleId} className="patch-approval__title">{copy.title}</strong>
    <p>{copy.lead}</p>

    <div className="patch-approval__targets">
      <div><small>{copy.awsTitle}</small><span>{copy.aws}</span></div>
      <div><small>{copy.onpremTitle}</small><span>{copy.onprem}</span></div>
    </div>

    {!patch && loadError === null && <p className="muted-copy">{copy.loading}</p>}
    {loadError !== null && <div className="notice error" role="alert"><strong>{copy.loadFailed}</strong><br />{errorMessage(loadError, t, copy.loadFailed)}</div>}

    {patch && <>
      <p className="patch-approval__summary">{patch.summary[language]}</p>
      <div className="patch-approval__files">
        <small>{copy.filesTitle(patch.files.length)}</small>
        <ul>
          {patch.files.map((file) => <li key={file.path}>
            <code>{file.path}</code>
            {file.generated
              ? <span className="chip">{copy.generated}</span>
              : <span className="patch-approval__counts"><span className="is-add">+{file.additions}</span> <span className="is-del">−{file.deletions}</span></span>}
            {file.change === 'added' && <span className="chip">{copy.added}</span>}
          </li>)}
        </ul>
      </div>
      {patch.notes.length > 0 && <div className="patch-approval__notes"><small>{copy.notesTitle}</small><ul>{patch.notes.map((note, index) => <li key={index}>{note[language]}</li>)}</ul></div>}
      <details className="technical-details patch-approval__diff" open>
        <summary>{copy.diffToggle}</summary>
        {diffFiles.map((file) => <details key={file.path} className="diff-file" open>
          <summary><code>{file.path}</code></summary>
          <pre className="diff-view">{file.lines.map((line, index) => <span key={index} className={lineClass(line)}>{line || ' '}</span>)}</pre>
        </details>)}
      </details>
      {patch.model && <p className="muted-copy">{copy.madeBy(patch.model)}</p>}
    </>}

    {decideError !== null && <div className="notice error" role="alert"><strong>{copy.decideFailed}</strong><br />{errorMessage(decideError, t, copy.decideFailed)}</div>}
    <div className="patch-approval__actions">
      <Keycap sound="start" disabled={!patch || deciding !== null} onClick={() => void decide('approve')}>{deciding === 'approve' ? copy.deciding : copy.approve}</Keycap>
      <Keycap variant="secondary" disabled={deciding !== null || (!patch && loadError === null)} onClick={() => void decide('reject')}>{deciding === 'reject' ? copy.deciding : copy.reject}</Keycap>
    </div>
    <p className="muted-copy">{copy.rejectHint}</p>
  </section>;
}
