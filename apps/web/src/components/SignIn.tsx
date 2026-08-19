import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { signInWithGoogle } from '../lib/firebase';
import { LanguageSwitcher } from './LanguageSwitcher';

export function SignIn() {
  const { t } = useTranslation('shell');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSignIn() {
    setError(null);
    setBusy(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('signIn.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">KPBooks</h1>
            <p className="text-sm text-slate-600">{t('signIn.subtitle')}</p>
          </div>
          <LanguageSwitcher compact />
        </div>
        <button
          type="button"
          onClick={onSignIn}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? t('signIn.busy') : t('signIn.google')}
        </button>
        {error && (
          <p className="text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
