import { useEffect, useId, useRef } from 'react';
import { Keycap } from '../../components/ui/Keycap';
import { LanguageToggle } from '../../components/ui/LanguageToggle';
import { SoundToggle } from '../../components/ui/SoundToggle';
import { useI18n } from '../../i18n/I18nProvider';
import { TargetToggle } from '../deployment-start/TargetToggle';
import { usePreferences } from './preferences';

/**
 * 환경설정 창. 바꾸는 즉시 적용되고 이 브라우저에 기억된다 (저장 버튼 없음).
 * 언어 · 사운드는 헤더에도 있는 같은 스위치다.
 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const copy = t.settings;
  const titleId = useId();
  const { preferences, update } = usePreferences();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  return <dialog ref={dialog} className="picker-dialog settings-dialog" aria-labelledby={titleId} onClose={onClose}
    onClick={(event) => { if (event.target === dialog.current) onClose(); }}>
    <div className="picker-dialog__body">
      <div className="picker-dialog__head">
        <h2 id={titleId}>{copy.title}</h2>
        <button type="button" className="toast__close" aria-label={copy.close} onClick={onClose}>×</button>
      </div>

      <section className="settings-group" aria-label={copy.display}>
        <h3>{copy.display}</h3>
        <div className="settings-row"><span>{t.header.language}</span><LanguageToggle /></div>
        <div className="settings-row"><span>{copy.sound}</span><SoundToggle /></div>
      </section>

      <section className="settings-group" aria-label={copy.notifications}>
        <h3>{copy.notifications}</h3>
        <label className="settings-row settings-row--check">
          <span><strong>{copy.notify}</strong><small>{copy.notifyCopy}</small></span>
          <input type="checkbox" checked={preferences.notify} onChange={(event) => update({ notify: event.target.checked })} />
        </label>
      </section>

      <section className="settings-group" aria-label={copy.deploy}>
        <h3>{copy.deploy}</h3>
        <TargetToggle name="default-deploy-target" legend={copy.defaultTarget} value={preferences.defaultTarget} onChange={(defaultTarget) => update({ defaultTarget })} />
        <label className="settings-row settings-row--check">
          <span><strong>{copy.reviewFirst}</strong><small>{copy.reviewFirstCopy}</small></span>
          <input type="checkbox" checked={preferences.reviewFirst} onChange={(event) => update({ reviewFirst: event.target.checked })} />
        </label>
      </section>

      <p className="picker-dialog__note">{copy.note}</p>
      <div className="picker-dialog__actions"><span /><Keycap variant="secondary" onClick={onClose}>{copy.close}</Keycap></div>
    </div>
  </dialog>;
}
