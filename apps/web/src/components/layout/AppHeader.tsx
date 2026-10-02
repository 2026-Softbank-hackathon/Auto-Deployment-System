import { useState } from 'react';
import type { Route } from '../../app/routes';
import { SettingsDialog } from '../../features/settings/SettingsDialog';
import { useI18n } from '../../i18n/I18nProvider';
import { LanguageToggle } from '../ui/LanguageToggle';
import { SoundToggle } from '../ui/SoundToggle';

export function AppHeader({ page }: { page: Route['page'] }) {
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  return <header className="app-header">
    <div className="app-header__title">{t.header.titles[page]}</div>
    <div className="app-header__controls">
      <SoundToggle /><LanguageToggle />
      <button type="button" className="settings-button" aria-haspopup="dialog" aria-label={t.settings.title} title={t.settings.title} onClick={() => setSettingsOpen(true)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
        </svg>
      </button>
    </div>
    <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
  </header>;
}
