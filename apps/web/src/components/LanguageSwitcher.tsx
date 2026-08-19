import { useTranslation } from 'react-i18next';
import { currentLanguage, setLanguage, type AppLanguage } from '../i18n';

/**
 * EN/ES toggle. Rendered on the public sign-in page and in the app header.
 * The choice persists in localStorage and applies instantly — i18next
 * re-renders every subscribed component on changeLanguage.
 */
export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { t, i18n } = useTranslation();
  const active = currentLanguage();

  const pick = (lang: AppLanguage) => {
    if (lang !== active) setLanguage(lang);
  };

  return (
    <div
      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5"
      role="group"
      aria-label={t('language')}
      // i18n object referenced so the component re-renders on language change
      data-lang={i18n.language}
    >
      {(['en', 'es'] as const).map((lang) => (
        <button
          key={lang}
          type="button"
          onClick={() => pick(lang)}
          className={
            'rounded px-2 py-1 text-xs font-medium transition-colors ' +
            (active === lang
              ? 'bg-slate-900 text-white'
              : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900')
          }
          aria-pressed={active === lang}
        >
          {compact ? lang.toUpperCase() : lang === 'en' ? 'English' : 'Español'}
        </button>
      ))}
    </div>
  );
}
