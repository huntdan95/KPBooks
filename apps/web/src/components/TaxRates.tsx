import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface TaxRate {
  id: string;
  name: string;
  ratePercent: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

type FormMode = null | { type: 'create' } | { type: 'edit'; id: string };

interface Draft {
  name: string;
  ratePercent: string;
  isActive: boolean;
}

const empty: Draft = { name: '', ratePercent: '', isActive: true };

export function TaxRates() {
  const { t } = useTranslation('sales');
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<FormMode>(null);
  const [draft, setDraft] = useState<Draft>(empty);

  const query = useQuery({
    queryKey: ['tax-rates', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ taxRates: TaxRate[] }>('/tax-rates', { companyId }),
  });

  const mutation = useMutation({
    mutationFn: async () => {
      if (!mode) throw new Error('no mode');
      const payload: Record<string, unknown> = {
        name: draft.name.trim(),
        ratePercent: draft.ratePercent,
      };
      if (mode.type === 'edit') payload.isActive = draft.isActive;
      if (mode.type === 'create') {
        return api<TaxRate>('/tax-rates', { method: 'POST', companyId, body: payload });
      }
      return api<TaxRate>(`/tax-rates/${mode.id}`, { method: 'PATCH', companyId, body: payload });
    },
    onSuccess: () => {
      setMode(null);
      setDraft(empty);
      void queryClient.invalidateQueries({ queryKey: ['tax-rates', companyId] });
    },
  });

  function startCreate() {
    setMode({ type: 'create' });
    setDraft(empty);
  }
  function startEdit(r: TaxRate) {
    setMode({ type: 'edit', id: r.id });
    setDraft({ name: r.name, ratePercent: r.ratePercent, isActive: r.isActive });
  }
  function cancel() {
    setMode(null);
    setDraft(empty);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.name.trim() || !draft.ratePercent || mutation.isPending) return;
    mutation.mutate();
  }

  const rates = query.data?.taxRates ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold tracking-tight text-slate-900">
            {t('taxRates.title')}
          </h3>
          <p className="text-sm text-slate-500">{t('taxRates.description')}</p>
        </div>
        <button
          type="button"
          onClick={mode ? cancel : startCreate}
          className="shrink-0 whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          {mode ? t('cancel', { ns: 'common' }) : t('taxRates.newButton')}
        </button>
      </div>

      {mode && (
        <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
          <h4 className="text-sm font-medium text-slate-700">
            {mode.type === 'create' ? t('taxRates.form.createTitle') : t('taxRates.form.editTitle')}
          </h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">
                {t('name', { ns: 'common' })} <span className="text-rose-600">*</span>
              </span>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                maxLength={120}
                placeholder={t('taxRates.form.namePlaceholder')}
                required
                autoFocus
                className={inputClass}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">
                {t('taxRates.form.rate')} <span className="text-rose-600">*</span>
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={draft.ratePercent}
                onChange={(e) => setDraft({ ...draft, ratePercent: e.target.value.replace(/[^0-9.]/g, '') })}
                placeholder="8.75"
                required
                className={inputClass + ' font-mono'}
              />
              <span className="text-xs text-slate-500">{t('taxRates.form.rateHint')}</span>
            </label>
          </div>

          {mode.type === 'edit' && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300"
              />
              {t('shared.active')}
            </label>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!draft.name.trim() || !draft.ratePercent || mutation.isPending}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {mutation.isPending
                ? t('shared.saving')
                : mode.type === 'create'
                  ? t('taxRates.form.saveRate')
                  : t('shared.saveChanges')}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
            >
              {t('cancel', { ns: 'common' })}
            </button>
          </div>

          {mutation.isError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formatError(mutation.error, t)}
            </div>
          )}
        </form>
      )}

      {query.isLoading && <p className="text-sm text-slate-500">{t('loading', { ns: 'common' })}</p>}
      {!query.isLoading && rates.length === 0 && (
        <p className="text-sm text-slate-500">{t('taxRates.empty')}</p>
      )}

      {rates.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">{t('name', { ns: 'common' })}</th>
                <th className="px-4 py-2 text-right font-medium">{t('taxRates.table.rate')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('shared.active')}</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {rates.map((r) => (
                <tr key={r.id} className={r.isActive ? '' : 'opacity-60'}>
                  <td className="px-4 py-2 text-slate-900">
                    {r.name}
                    {!r.isActive && (
                      <span className="ml-2 text-xs text-slate-500">{t('shared.inactive')}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">
                    {Number(r.ratePercent).toFixed(2)}%
                  </td>
                  <td className="px-4 py-2 text-center">{r.isActive ? '✓' : '—'}</td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => startEdit(r)}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                    >
                      {t('edit', { ns: 'common' })}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const inputClass =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900';

function formatError(err: unknown, t: TFunction<'sales'>): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? t('shared.errorLabel')}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : t('shared.failedToSave');
}
