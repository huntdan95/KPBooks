import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface CompanyRow {
  id: string;
  name: string;
  closedThroughDate: string | null;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Close-the-books toggle. Setting closed_through_date causes the
 * ledger_enforce_closed_period trigger to reject any new journal entry with
 * an entry_date <= the closed-through. Only owners/admins can change it.
 *
 * Use case: at month-end (or year-end) the CPA reviews the books, then
 * closes the period so an accidental late-entered transaction can't change
 * a finalised P&L. Reopening clears the date.
 */
export function PeriodClose() {
  const { t } = useTranslation(['reports', 'common']);
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [draftDate, setDraftDate] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['company-current', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<CompanyRow>('/companies/current', { companyId }),
  });

  const mutation = useMutation({
    mutationFn: async (closedThroughDate: string | null) => {
      return api<CompanyRow>('/companies/current', {
        method: 'PATCH',
        companyId,
        body: { closedThroughDate },
      });
    },
    onSuccess: () => {
      setError(null);
      setDraftDate('');
      void queryClient.invalidateQueries({ queryKey: ['company-current', companyId] });
    },
    onError: (err) => {
      setError(formatError(err, t));
    },
  });

  const closedThrough = query.data?.closedThroughDate ?? null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draftDate) return;
    if (mutation.isPending) return;
    if (!confirm(t('periodClose.confirmClose', { date: draftDate }))) {
      return;
    }
    mutation.mutate(draftDate);
  }

  function reopen() {
    if (!confirm(t('periodClose.confirmReopen'))) {
      return;
    }
    mutation.mutate(null);
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold tracking-tight text-slate-900">
          {t('periodClose.title')}
        </h3>
        <p className="text-sm text-slate-500">{t('periodClose.description')}</p>
      </div>

      {query.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : t('periodClose.loadError')}
        </p>
      )}

      {query.data && (
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-xs uppercase tracking-wider text-slate-500">
                {t('periodClose.currentState')}
              </p>
              {closedThrough ? (
                <p className="text-lg font-medium text-slate-900">
                  {t('periodClose.closedThrough')}{' '}
                  <span className="font-mono text-emerald-700">{closedThrough}</span>
                </p>
              ) : (
                <p className="text-lg font-medium text-slate-900">
                  <span className="text-slate-500">{t('periodClose.booksOpen')}</span>{' '}
                  {t('periodClose.noCloseDate')}
                </p>
              )}
            </div>
            {closedThrough && (
              <button
                type="button"
                onClick={reopen}
                disabled={mutation.isPending}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
              >
                {t('periodClose.reopen')}
              </button>
            )}
          </div>
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
        <h4 className="text-sm font-medium text-slate-700">
          {closedThrough ? t('periodClose.moveCloseDate') : t('periodClose.closeThrough')}
        </h4>
        <div className="flex items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            <span>{t('common:date')}</span>
            <input
              type="date"
              value={draftDate}
              onChange={(e) => setDraftDate(e.target.value)}
              max={todayIso()}
              className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-slate-900 focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={!draftDate || mutation.isPending}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {mutation.isPending
              ? t('saving')
              : closedThrough
                ? t('periodClose.updateCloseDate')
                : t('periodClose.closeBooks')}
          </button>
        </div>
        <p className="text-xs text-slate-500">{t('periodClose.tip')}</p>
      </form>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {error}
        </div>
      )}
    </div>
  );
}

function formatError(err: unknown, t: TFunction<['reports', 'common']>): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? t('errorLabel')}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : t('periodClose.updateError');
}
