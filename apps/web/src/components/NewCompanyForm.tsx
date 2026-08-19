import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface CreateCompanyResponse {
  id: string;
  name: string;
  accountsCreated: number;
}

/**
 * The shared "create a new company" form. Used both by the splash screen
 * (CreateCompany.tsx) when the user has no memberships AND by the modal
 * triggered from the company picker once they're inside the app.
 *
 * On success: switches the active company to the newly-created one and
 * invalidates the /me query so the picker shows the new entry.
 */
export function NewCompanyForm({
  onCreated,
  autoFocus = true,
}: {
  /** Called with the new company id after successful creation. */
  onCreated?: (id: string) => void;
  autoFocus?: boolean;
}) {
  const { t } = useTranslation('shell');
  const [name, setName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [ein, setEin] = useState('');
  const queryClient = useQueryClient();
  const { setCompanyId } = useCurrentCompany();

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { name: name.trim() };
      if (legalName.trim()) body.legalName = legalName.trim();
      if (ein.trim()) body.ein = ein.trim();
      return api<CreateCompanyResponse>('/companies', { method: 'POST', body });
    },
    onSuccess: async (data) => {
      // Refetch /me FIRST so the new membership is in cache before we switch
      // active company. Otherwise AppShell sees a companyId that isn't in its
      // memberships list and snaps back to the previous one.
      await queryClient.refetchQueries({ queryKey: ['me'] });
      setCompanyId(data.id);
      onCreated?.(data.id);
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || mutation.isPending) return;
    mutation.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">{t('companyForm.displayName')}</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('companyForm.displayNamePlaceholder')}
          autoFocus={autoFocus}
          required
          maxLength={120}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">{t('companyForm.legalName')}</span>
        <input
          type="text"
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
          placeholder={t('companyForm.legalNamePlaceholder')}
          maxLength={160}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">{t('companyForm.ein')}</span>
        <input
          type="text"
          value={ein}
          onChange={(e) => setEin(e.target.value)}
          placeholder={t('companyForm.einPlaceholder')}
          maxLength={20}
          className={inputClass + ' font-mono'}
        />
      </label>

      <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
        {t('companyForm.seedNote')}
      </div>

      <button
        type="submit"
        disabled={mutation.isPending || !name.trim()}
        className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {mutation.isPending ? t('companyForm.creating') : t('companyForm.submit')}
      </button>

      {mutation.isError && (
        <p className="text-sm text-rose-600">
          {mutation.error instanceof ApiError
            ? (() => {
                const body = mutation.error.body as { error?: string; message?: string } | null;
                return body?.message ?? body?.error ?? t('companyForm.failed');
              })()
            : mutation.error instanceof Error
              ? mutation.error.message
              : t('companyForm.failed')}
        </p>
      )}
    </form>
  );
}

const inputClass =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900';
