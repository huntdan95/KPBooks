import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type Translate = TFunction<readonly ['banking', 'common']>;

interface Account {
  id: string;
  code: string;
  name: string;
  subtype: string;
  isActive: boolean;
}

interface ReconciliationRow {
  id: string;
  bankAccountId: string;
  statementDate: string;
  statementBalance: string;
  beginningBalance: string;
  status: 'in_progress' | 'completed';
  notes: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface SummaryTxn {
  id: string;
  transactionDate: string;
  description: string;
  amount: string;
  cleared: boolean;
}

interface Summary {
  id: string;
  bankAccountId: string;
  statementDate: string;
  statementBalance: string;
  beginningBalance: string;
  status: 'in_progress' | 'completed';
  notes: string | null;
  transactions: SummaryTxn[];
  clearedTotal: string;
  target: string;
  diff: string;
  isBalanced: boolean;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

function formatUsd(s: string): string {
  if (!s) return '$0.00';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

export function Reconcile() {
  const { t } = useTranslation(['banking', 'common']);
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [bankAccountId, setBankAccountId] = useState<string>('');
  const [activeReconciliationId, setActiveReconciliationId] = useState<string | null>(null);
  const [draftStatementDate, setDraftStatementDate] = useState<string>(todayIso);
  const [draftStatementBalance, setDraftStatementBalance] = useState<string>('');

  const accountsQuery = useQuery({
    queryKey: ['accounts', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ accounts: Account[] }>('/ledger/accounts?active=true', { companyId }),
  });
  const bankAccounts = useMemo(
    () =>
      (accountsQuery.data?.accounts ?? [])
        .filter((a) => a.isActive && (a.subtype === 'bank' || a.subtype === 'credit_card'))
        .sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQuery.data],
  );

  const recsQuery = useQuery({
    queryKey: ['reconciliations', companyId, bankAccountId],
    enabled: Boolean(companyId) && Boolean(bankAccountId),
    queryFn: () =>
      api<{ reconciliations: ReconciliationRow[] }>(
        `/banking/reconciliations?bankAccountId=${bankAccountId}`,
        { companyId },
      ),
  });
  const recs = recsQuery.data?.reconciliations ?? [];
  const inProgress = recs.find((r) => r.status === 'in_progress');

  const summaryQuery = useQuery({
    queryKey: ['reconciliation-summary', activeReconciliationId, companyId],
    enabled: Boolean(activeReconciliationId) && Boolean(companyId),
    queryFn: () =>
      api<Summary>(`/banking/reconciliations/${activeReconciliationId}`, { companyId }),
  });

  const startMutation = useMutation({
    mutationFn: async () =>
      api<{ id: string }>('/banking/reconciliations', {
        method: 'POST',
        companyId,
        body: {
          bankAccountId,
          statementDate: draftStatementDate,
          statementBalance: draftStatementBalance,
        },
      }),
    onSuccess: (data) => {
      setActiveReconciliationId(data.id);
      void queryClient.invalidateQueries({
        queryKey: ['reconciliations', companyId, bankAccountId],
      });
    },
  });

  const clearMutation = useMutation({
    mutationFn: async ({ id, cleared }: { id: string; cleared: boolean }) =>
      api(`/banking/reconciliations/${activeReconciliationId}/clear`, {
        method: 'POST',
        companyId,
        body: { bankTransactionId: id, cleared },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['reconciliation-summary', activeReconciliationId, companyId],
      });
    },
  });

  const finaliseMutation = useMutation({
    mutationFn: async () =>
      api(`/banking/reconciliations/${activeReconciliationId}/finalise`, {
        method: 'POST',
        companyId,
        body: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['reconciliation-summary', activeReconciliationId, companyId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['reconciliations', companyId, bankAccountId],
      });
    },
  });

  const reopenMutation = useMutation({
    mutationFn: async () =>
      api(`/banking/reconciliations/${activeReconciliationId}/reopen`, {
        method: 'POST',
        companyId,
        body: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['reconciliation-summary', activeReconciliationId, companyId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['reconciliations', companyId, bankAccountId],
      });
    },
  });

  const summary = summaryQuery.data;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold tracking-tight text-slate-900">
          {t('reconcile.title')}
        </h3>
        <p className="text-sm text-slate-500">{t('reconcile.subtitle')}</p>
      </div>

      <section className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            <span>{t('reconcile.bankAccount')}</span>
            <select
              value={bankAccountId}
              onChange={(e) => {
                setBankAccountId(e.target.value);
                setActiveReconciliationId(null);
              }}
              className={inputClass}
            >
              <option value="">{t('reconcile.selectPlaceholder')}</option>
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {bankAccountId && (
          <>
            {inProgress && !activeReconciliationId && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {t('reconcile.inProgressLabel')}{' '}
                <button
                  type="button"
                  onClick={() => setActiveReconciliationId(inProgress.id)}
                  className="font-medium underline"
                >
                  {inProgress.statementDate} — {formatUsd(inProgress.statementBalance)}
                </button>
              </div>
            )}

            {!inProgress && !activeReconciliationId && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-slate-700">{t('reconcile.startTitle')}</h4>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="flex flex-col gap-1 text-sm text-slate-600">
                    <span>{t('reconcile.statementDate')}</span>
                    <input
                      type="date"
                      value={draftStatementDate}
                      onChange={(e) => setDraftStatementDate(e.target.value)}
                      className={inputClass}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm text-slate-600">
                    <span>{t('reconcile.endingBalance')}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={draftStatementBalance}
                      onChange={(e) =>
                        setDraftStatementBalance(e.target.value.replace(/[^0-9.\-]/g, ''))
                      }
                      placeholder="1234.56"
                      className={inputClass + ' font-mono w-36'}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => startMutation.mutate()}
                    disabled={!draftStatementBalance || startMutation.isPending}
                    className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                  >
                    {startMutation.isPending ? t('reconcile.starting') : t('reconcile.start')}
                  </button>
                </div>
                {startMutation.isError && (
                  <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                    {formatError(startMutation.error, t)}
                  </div>
                )}
              </div>
            )}

            {recs.filter((r) => r.status === 'completed').length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-slate-600">
                  {t('reconcile.past', {
                    count: recs.filter((r) => r.status === 'completed').length,
                  })}
                </summary>
                <ul className="mt-2 space-y-1 text-xs text-slate-700">
                  {recs
                    .filter((r) => r.status === 'completed')
                    .map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-3">
                        <span>
                          {r.statementDate} — {formatUsd(r.statementBalance)}
                        </span>
                        <button
                          type="button"
                          onClick={() => setActiveReconciliationId(r.id)}
                          className="text-slate-600 underline hover:text-slate-900"
                        >
                          {t('reconcile.view')}
                        </button>
                      </li>
                    ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>

      {summary && (
        <section className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-slate-700">
              {summary.status === 'completed'
                ? t('reconcile.completedTitle')
                : t('reconcile.inProgressTitle')}
              <span className="ml-2 text-slate-500">
                {t('reconcile.headerMeta', {
                  date: summary.statementDate,
                  balance: formatUsd(summary.statementBalance),
                })}
              </span>
            </h4>
            <button
              type="button"
              onClick={() => setActiveReconciliationId(null)}
              className="text-sm text-slate-600 hover:text-slate-900"
            >
              {t('common:close')}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
            <Stat label={t('reconcile.stats.beginning')} value={formatUsd(summary.beginningBalance)} />
            <Stat label={t('reconcile.stats.statement')} value={formatUsd(summary.statementBalance)} />
            <Stat label={t('reconcile.stats.cleared')} value={formatUsd(summary.clearedTotal)} />
            <Stat
              label={t('reconcile.stats.difference')}
              value={formatUsd(summary.diff)}
              tone={summary.isBalanced ? 'good' : 'bad'}
            />
          </div>

          {summary.status === 'in_progress' && (
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => finaliseMutation.mutate()}
                disabled={!summary.isBalanced || finaliseMutation.isPending}
                className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {finaliseMutation.isPending
                  ? t('reconcile.finalising')
                  : summary.isBalanced
                    ? t('reconcile.finalise')
                    : t('reconcile.offBy', { amount: formatUsd(summary.diff) })}
              </button>
              {finaliseMutation.isError && (
                <span className="text-xs text-rose-600">
                  {formatError(finaliseMutation.error, t)}
                </span>
              )}
            </div>
          )}

          {summary.status === 'completed' && (
            <div className="flex items-center gap-3">
              <span className="text-xs text-emerald-700">{t('reconcile.locked')}</span>
              <button
                type="button"
                onClick={() => {
                  if (confirm(t('reconcile.reopenConfirm'))) {
                    reopenMutation.mutate();
                  }
                }}
                disabled={reopenMutation.isPending}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-100 disabled:opacity-50"
              >
                {t('reconcile.reopen')}
              </button>
            </div>
          )}

          <div className="overflow-hidden rounded-md border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="w-10 px-3 py-2"></th>
                  <th className="px-3 py-2 text-left font-medium">{t('common:date')}</th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('reconcile.columnDescription')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">{t('common:amount')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {summary.transactions.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-3 text-sm text-slate-500">
                      {t('reconcile.noPostedTransactions', { date: summary.statementDate })}
                    </td>
                  </tr>
                ) : (
                  summary.transactions.map((txn) => (
                    <tr key={txn.id} className={txn.cleared ? 'bg-emerald-50/40' : ''}>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={txn.cleared}
                          disabled={summary.status === 'completed' || clearMutation.isPending}
                          onChange={(e) =>
                            clearMutation.mutate({ id: txn.id, cleared: e.target.checked })
                          }
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-700">{txn.transactionDate}</td>
                      <td className="px-3 py-2 text-slate-900">{txn.description}</td>
                      <td
                        className={
                          'px-3 py-2 text-right font-mono ' +
                          (txn.amount.startsWith('-') ? 'text-rose-700' : 'text-emerald-700')
                        }
                      >
                        {formatUsd(txn.amount)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {clearMutation.isError && (
            <div className="text-xs text-rose-600">{formatError(clearMutation.error, t)}</div>
          )}
        </section>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'bad';
}) {
  const colour =
    tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-rose-700' : 'text-slate-900';
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 p-2">
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-base font-mono ${colour}`}>{value}</div>
    </div>
  );
}

const inputClass =
  'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-slate-900 focus:outline-none';

function formatError(err: unknown, t: Translate): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? t('errors.label')}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : t('errors.operationFailed');
}
