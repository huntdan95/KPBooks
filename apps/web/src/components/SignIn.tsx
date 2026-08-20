import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { consumeRedirectResult, signInWithGoogle } from '../lib/firebase';
import { LanguageSwitcher } from './LanguageSwitcher';

/** Firebase error codes that mean "the browser withheld sign-in storage". */
const STORAGE_BLOCKED_CODES = new Set([
  'auth/missing-initial-state',
  'auth/web-storage-unsupported',
]);

export function SignIn() {
  const { t } = useTranslation('shell');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function describe(err: unknown): string {
    const code = (err as { code?: string } | null)?.code;
    if (code && STORAGE_BLOCKED_CODES.has(code)) return t('signIn.storageBlocked');
    return err instanceof Error ? err.message : t('signIn.failed');
  }

  // A redirect sign-in finishes by loading this page again. Without claiming
  // the result, a failed redirect would drop the user back on a silent button
  // with no idea what went wrong.
  useEffect(() => {
    let cancelled = false;
    void consumeRedirectResult().catch((err: unknown) => {
      if (!cancelled) setError(describe(err));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onSignIn() {
    setError(null);
    setBusy(true);
    try {
      await signInWithGoogle();
      // On mobile this never resolves — signInWithRedirect navigates away.
    } catch (err) {
      setError(describe(err));
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
