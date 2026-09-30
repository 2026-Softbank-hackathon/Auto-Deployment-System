import type { Route } from '../../app/routes';
import { useI18n } from '../../i18n/I18nProvider';
import { LanguageToggle } from '../ui/LanguageToggle';
import { SoundToggle } from '../ui/SoundToggle';

export function AppHeader({ page }: { page: Route['page'] }) {
  const { t } = useI18n();
  return <header className="app-header">
    <div className="app-header__title">{t.header.titles[page]}</div>
    <div className="app-header__controls"><SoundToggle /><LanguageToggle /></div>
  </header>;
}
