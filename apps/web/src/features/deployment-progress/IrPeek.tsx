import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { DeploymentApiError, getDeploymentIr, type DeploymentIrResponse } from '../../api/deployment-api';
import { Keycap } from '../../components/ui/Keycap';
import { errorMessage, useI18n } from '../../i18n/I18nProvider';
import type { IrOrigin } from './deploy-story';

/**
 * 장면의 IR 판 오른쪽 위에 붙는 말풍선 버튼. 누르면 이번 배포가 실제로 쓰는 IR(배포 명세)을 창으로 보여 준다.
 * 창을 열 때 서버에서 읽고(API-08), 열어 둔 채 상태가 바뀌면 다시 읽는다. IR이 없으면(404) 그렇다고 알린다.
 * 새로 만든 IR인지 이전 배포에서 복사한 IR인지는 장면과 같은 판단(origin)을 쓴다.
 * 위치는 장면 좌표를 백분율로 바꾼 값(style)으로 받는다 — 코로의 생각 풍선과 같은 방식.
 */
export function IrPeek({ deploymentId, origin, status, style }: { deploymentId: string; origin: IrOrigin | null; /** 배포 상태 — 열어 둔 동안 바뀌면 IR을 다시 읽는다 */ status: string | null; style: CSSProperties }) {
  const { t } = useI18n();
  const copy = t.run.ir;
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ ir: DeploymentIrResponse } | { missing: true } | { error: unknown } | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    getDeploymentIr(deploymentId).then(
      (ir) => { if (active) setState({ ir }); },
      (error) => { if (active) setState(error instanceof DeploymentApiError && error.status === 404 ? { missing: true } : { error }); },
    );
    return () => { active = false; };
  }, [deploymentId, open, status]);

  return <>
    <button type="button" className="ir-bubble" style={style} aria-haspopup="dialog" onClick={() => setOpen(true)}>{copy.toggle}</button>
    <dialog ref={dialog} className="picker-dialog ir-dialog" aria-labelledby={titleId} onClose={() => setOpen(false)}
      onClick={(event) => { if (event.target === dialog.current) setOpen(false); }}>
      <div className="picker-dialog__body">
        <div className="picker-dialog__head">
          <h2 id={titleId}>{copy.title}</h2>
          <button type="button" className="toast__close" aria-label={copy.close} onClick={() => setOpen(false)}>×</button>
        </div>
        {origin && <p className="ir-peek__origin"><span className={`ir-peek__badge is-${origin}`}>{copy.badge[origin]}</span> {copy.origin[origin]}</p>}
        {state === null ? <p>{copy.loading}</p>
          : 'missing' in state ? <p>{copy.missing}</p>
            : 'error' in state ? <p role="alert">{errorMessage(state.error, t, copy.failed)}</p>
              : <pre className="ir-dialog__json">{JSON.stringify(state.ir.ir, null, 2)}</pre>}
        <div className="picker-dialog__actions"><span /><Keycap variant="secondary" onClick={() => setOpen(false)}>{copy.close}</Keycap></div>
      </div>
    </dialog>
  </>;
}
