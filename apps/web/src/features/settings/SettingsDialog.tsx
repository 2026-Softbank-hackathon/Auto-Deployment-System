import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Keycap } from '../../components/ui/Keycap';
import { LanguageToggle } from '../../components/ui/LanguageToggle';
import { SoundToggle } from '../../components/ui/SoundToggle';
import { useI18n } from '../../i18n/I18nProvider';
import { TargetToggle } from '../deployment-start/TargetToggle';
import { usePreferences } from './preferences';

const settingsTabs = ['display', 'notifications', 'deploy'] as const;
type SettingsTab = typeof settingsTabs[number];

/**
 * 환경설정 창. 바꾸는 즉시 적용되고 이 브라우저에 기억된다 (저장 버튼 없음).
 * 언어 · 효과음도 여기에서만 바꾼다(헤더에는 톱니바퀴 버튼만 둔다).
 */
export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const copy = t.settings;
  const titleId = useId();
  const { preferences, update } = usePreferences();
  const baseId = useId();
  const [tab, setTab] = useState<SettingsTab>('display');
  // 탭 목록에서는 좌우 화살표로 옮긴다 (탭 한 개만 Tab 순서에 들어간다).
  function moveTab(event: KeyboardEvent<HTMLButtonElement>, current: SettingsTab) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = settingsTabs[(settingsTabs.indexOf(current) + step + settingsTabs.length) % settingsTabs.length];
    setTab(next);
    document.getElementById(`${baseId}-tab-${next}`)?.focus();
  }
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

      {/* 설정이 늘어나면 탭을 하나 더 추가한다. 탭마다 한 가지 주제만 담는다. */}
      <div className="tabs settings-tabs" role="tablist" aria-label={copy.title}>
        {settingsTabs.map((key) => <button key={key} type="button" role="tab" id={`${baseId}-tab-${key}`} className="tabs__tab"
          aria-selected={tab === key} aria-controls={`${baseId}-panel-${key}`} tabIndex={tab === key ? 0 : -1}
          onClick={() => setTab(key)} onKeyDown={(event) => moveTab(event, key)}>{copy.tabs[key]}</button>)}
      </div>

      <div className="settings-panel" role="tabpanel" id={`${baseId}-panel-${tab}`} aria-labelledby={`${baseId}-tab-${tab}`}>
        {tab === 'display' && <>
          <div className="settings-row"><span>{t.header.language}</span><LanguageToggle /></div>
          <div className="settings-row"><span>{copy.sound}</span><SoundToggle /></div>
        </>}

        {tab === 'notifications' && <label className="settings-row settings-row--check">
          <span><strong>{copy.notify}</strong><small>{copy.notifyCopy}</small></span>
          <input type="checkbox" checked={preferences.notify} onChange={(event) => update({ notify: event.target.checked })} />
        </label>}

        {tab === 'deploy' && <>
          <TargetToggle name="default-deploy-target" legend={copy.defaultTarget} value={preferences.defaultTarget} onChange={(defaultTarget) => update({ defaultTarget })} />
          <label className="settings-row settings-row--check">
            <span><strong>{copy.reviewFirst}</strong><small>{copy.reviewFirstCopy}</small></span>
            <input type="checkbox" checked={preferences.reviewFirst} onChange={(event) => update({ reviewFirst: event.target.checked })} />
          </label>
        </>}
      </div>

      <p className="picker-dialog__note">{copy.note}</p>
      <div className="picker-dialog__actions"><span /><Keycap variant="secondary" onClick={onClose}>{copy.close}</Keycap></div>
    </div>
  </dialog>;
}
