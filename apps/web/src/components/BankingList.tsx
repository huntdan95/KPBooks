import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { BankRules } from './BankRules';
import { Reconcile } from './Reconcile';

type BankTxnStatus = 'unmatched' | 'suggested' | 'posted' | 'ignored';
type Confidence = 'high' | 'medium' | 'low';
type Translate = TFunction<readonly ['banking', 'common']>;

interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subtype: string;
  isActive: boolean;
}

interface BankTxn {
  id: string;
  bankAccountId: string;
  transactionDate: string;
  description: string;
  amount: string;
  balance: string | null;
  status: BankTxnStatus;
  suggestedAccountId: string | null;
  suggestedConfidence: Confidence | null;
  suggestedReason: string | null;
  postedJournalEntryId: string | null;
  importBatchId: string;
  createdAt: string;
}

interface ImportResult {
  importBatchId: string;
  imported: number;
  duplicates: number;
  /** How many freshly-imported rows matched a saved bank rule and got pre-categorized. */
  ruleMatched: number;
  warnings: string[];
}

interface SuggestResult {
  updated: number;
  failed: number;
  errors: string[];
}

const STATUS_COLOR: Record<BankTxnStatus, string> = {
  unmatched: 'bg-slate-100 text-slate-700 ring-slate-300',
  suggested: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  posted: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  ignored: 'bg-slate-100 text-slate-500 ring-slate-300',
};

const CONFIDENCE_COLOR: Record<Confidence, string> = {
  high: 'text-emerald-700',
  medium: 'text-amber-700',
  low: 'text-rose-700',
};

function formatUsd(s: string): string {
  if (!s) return '$0.00';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

export function BankingList() {
  const { t } = useTranslation(['banking', 'common']);
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [view, setView] = useState<'transactions' | 'reconcile' | 'rules'>('transactions');
  const [selectedBankAccountId, setSelectedBankAccountId] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<BankTxnStatus | ''>('unmatched');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [suggestResult, setSuggestResult] = useState<SuggestResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

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

  const allActiveAccounts = useMemo(
    () =>
      (accountsQuery.data?.accounts ?? [])
        .filter((a) => a.isActive && a.subtype !== 'accounts_receivable' && a.subtype !== 'accounts_payable')
        .sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQuery.data],
  );

  const accountById = useMemo(
    () => new Map((accountsQuery.data?.accounts ?? []).map((a) => [a.id, a])),
    [accountsQuery.data],
  );

  const aiStatusQuery = useQuery({
    queryKey: ['banking-ai-status'],
    enabled: Boolean(companyId),
    queryFn: () => api<{ available: boolean }>('/banking/ai-status'),
    staleTime: 60_000,
  });

  const txnsQuery = useQuery({
    queryKey: ['bank-transactions', companyId, statusFilter, selectedBankAccountId],
    enabled: Boolean(companyId),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (statusFilter) qs.set('status', statusFilter);
      if (selectedBankAccountId) qs.set('bankAccountId', selectedBankAccountId);
      const q = qs.toString();
      return api<{ transactions: BankTxn[] }>(`/banking/transactions${q ? `?${q}` : ''}`, { companyId });
    },
  });

  const txns = txnsQuery.data?.transactions ?? [];

  const importMutation = useMutation({
    mutationFn: async (csvText: string) => {
      if (!selectedBankAccountId) throw new Error(t('list.pickBankAccountFirst'));
      return api<ImportResult>('/banking/import-csv', {
        method: 'POST',
        companyId,
        body: { bankAccountId: selectedBankAccountId, csvText },
      });
    },
    onSuccess: (data) => {
      setImportResult(data);
      setImportError(null);
      void queryClient.invalidateQueries({ queryKey: ['bank-transactions', companyId] });
    },
    onError: (err) => {
      setImportError(formatError(err, t));
      setImportResult(null);
    },
  });

  const suggestMutation = useMutation({
    mutationFn: async (ids: string[]) =>
      api<SuggestResult>('/banking/categorize-suggest', {
        method: 'POST',
        companyId,
        body: { bankTransactionIds: ids },
      }),
    onSuccess: (data) => {
      setSuggestResult(data);
      setSelectedIds(new Set());
      void queryClient.invalidateQueries({ queryKey: ['bank-transactions', companyId] });
    },
  });

  const postMutation = useMutation({
    mutationFn: async ({ id, accountId }: { id: string; accountId?: string }) =>
      api<{ id: string; postedJournalEntryId: string }>(`/banking/transactions/${id}/post`, {
        method: 'POST',
        companyId,
        body: accountId ? { accountId } : {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bank-transactions', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['trial-balance', companyId] });
    },
  });

  const ignoreMutation = useMutation({
    mutationFn: async (id: string) =>
      api<{ id: string }>(`/banking/transactions/${id}/ignore`, {
        method: 'POST',
        companyId,
        body: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bank-transactions', companyId] });
    },
  });

  async function handleFile(file: File) {
    setImportError(null);
    setImportResult(null);
    if (!selectedBankAccountId) {
      setImportError(t('list.pickBankAccountFirst'));
      return;
    }
    if (file.size > 2_000_000) {
      setImportError(t('list.fileTooLarge', { size: (file.size / 1e6).toFixed(1) }));
      return;
    }
    const text = await file.text();
    importMutation.mutate(text);
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const unmatchedCount = txns.filter((txn) => txn.status === 'unmatched').length;
  const aiAvailable = aiStatusQuery.data?.available ?? false;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">{t('list.title')}</h2>
          <p className="text-sm text-slate-500">{t('list.subtitle')}</p>
        </div>
        <div className="flex gap-1 border-b border-slate-200">
          {(
            [
              { id: 'transactions', labelKey: 'list.tabs.transactions' },
              { id: 'reconcile', labelKey: 'list.tabs.reconcile' },
              { id: 'rules', labelKey: 'list.tabs.rules' },
            ] as const
          ).map((tab) => {
            const active = view === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setView(tab.id)}
                className={
                  'border-b-2 px-3 py-1.5 text-sm transition-colors -mb-px ' +
                  (active
                    ? 'border-slate-900 font-medium text-slate-900'
                    : 'border-transparent text-slate-500 hover:text-slate-800')
                }
              >
                {t(tab.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {view === 'reconcile' && <Reconcile />}
      {view === 'rules' && <BankRules />}
      {view === 'transactions' && (
        <>

      {/* ----------- Bank account picker + import ------------- */}
      <section className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            <span>{t('list.bankAccount')}</span>
            <select
              value={selectedBankAccountId}
              onChange={(e) => setSelectedBankAccountId(e.target.value)}
              className={inputClass}
            >
              <option value="">{t('list.selectPlaceholder')}</option>
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name} (
                  {t(`accountSubtype.${a.subtype}`, { defaultValue: a.subtype.replace(/_/g, ' ') })})
                </option>
              ))}
            </select>
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
              if (fileInputRef.current) fileInputRef.current.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={!selectedBankAccountId || importMutation.isPending}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50"
          >
            {importMutation.isPending ? t('list.importing') : t('list.importCsv')}
          </button>
        </div>
        {importResult && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            {t('list.imported', { count: importResult.imported })}
            {importResult.duplicates > 0
              ? t('list.skippedDuplicates', { count: importResult.duplicates })
              : ''}
            {importResult.ruleMatched > 0
              ? t('list.preCategorized', { count: importResult.ruleMatched })
              : ''}
            {importResult.warnings.length > 0 && (
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer">
                  {t('list.parserWarnings', { count: importResult.warnings.length })}
                </summary>
                <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5">
                  {importResult.warnings.slice(0, 50).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {importError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {importError}
          </div>
        )}
        <p className="text-xs text-slate-500">{t('list.csvHint')}</p>
      </section>

      {/* ----------- Filter + AI categorize batch ------------- */}
      <section className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm text-slate-600">
          <span>{t('common:status')}</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as BankTxnStatus | '')}
            className={inputClass}
          >
            <option value="">{t('list.statusAll')}</option>
            <option value="unmatched">{t('txnStatus.unmatched')}</option>
            <option value="suggested">{t('txnStatus.suggested')}</option>
            <option value="posted">{t('txnStatus.posted')}</option>
            <option value="ignored">{t('txnStatus.ignored')}</option>
          </select>
        </label>

        {aiAvailable ? (
          <button
            type="button"
            onClick={() => {
              const ids =
                selectedIds.size > 0
                  ? Array.from(selectedIds)
                  : txns.filter((txn) => txn.status === 'unmatched').map((txn) => txn.id).slice(0, 50);
              if (ids.length === 0) return;
              suggestMutation.mutate(ids);
            }}
            disabled={suggestMutation.isPending || (selectedIds.size === 0 && unmatchedCount === 0)}
            className="rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {suggestMutation.isPending
              ? t('list.askingClaude')
              : selectedIds.size > 0
                ? t('list.suggestSelected', { n: selectedIds.size })
                : t('list.suggestNext', { n: Math.min(unmatchedCount, 50) })}
          </button>
        ) : (
          <p className="text-xs text-slate-500">{t('list.aiUnavailable')}</p>
        )}

        {suggestResult && (
          <p className="text-xs text-slate-600">
            {t('list.suggested', { n: suggestResult.updated })}
            {suggestResult.failed > 0 ? t('list.suggestFailed', { n: suggestResult.failed }) : ''}
            {suggestResult.errors.length > 0
              ? t('list.suggestError', { error: suggestResult.errors[0] })
              : ''}
          </p>
        )}

        {suggestMutation.isError && (
          <p className="text-xs text-rose-600">
            {t('list.aiError', { error: formatError(suggestMutation.error, t) })}
          </p>
        )}
      </section>

      {/* ----------- Transactions table ------------- */}
      {txnsQuery.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {!txnsQuery.isLoading && txns.length === 0 && (
        <p className="text-sm text-slate-500">{t('list.empty')}</p>
      )}
      {txns.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="w-10 px-3 py-2"></th>
                <th className="px-3 py-2 text-left font-medium">{t('common:date')}</th>
                <th className="px-3 py-2 text-left font-medium">{t('list.columns.description')}</th>
                <th className="px-3 py-2 text-right font-medium">{t('common:amount')}</th>
                <th className="px-3 py-2 text-left font-medium">
                  {t('list.columns.suggestedAccount')}
                </th>
                <th className="px-3 py-2 text-center font-medium">{t('common:status')}</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {txns.map((txn) => {
                const suggested = txn.suggestedAccountId
                  ? accountById.get(txn.suggestedAccountId)
                  : null;
                const isPostable = txn.status === 'unmatched' || txn.status === 'suggested';
                return (
                  <tr key={txn.id} className={txn.status === 'ignored' ? 'opacity-60' : ''}>
                    <td className="px-3 py-2 text-center">
                      {isPostable && (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(txn.id)}
                          onChange={() => toggleSelect(txn.id)}
                        />
                      )}
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
                    <td className="px-3 py-2">
                      {isPostable ? (
                        <div className="flex items-center gap-2">
                          <select
                            value={txn.suggestedAccountId ?? ''}
                            onChange={(e) => {
                              postMutation.mutate({ id: txn.id, accountId: e.target.value });
                            }}
                            disabled={postMutation.isPending}
                            className="max-w-xs rounded-md border border-slate-300 bg-white px-2 py-1 text-xs focus:border-slate-900 focus:outline-none"
                          >
                            <option value="">{t('list.selectAndPost')}</option>
                            {allActiveAccounts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.code} — {a.name}
                              </option>
                            ))}
                          </select>
                          {txn.suggestedConfidence && (
                            <span
                              className={
                                'text-xs ' + CONFIDENCE_COLOR[txn.suggestedConfidence]
                              }
                              title={txn.suggestedReason ?? ''}
                            >
                              {t(`confidence.${txn.suggestedConfidence}`)}
                            </span>
                          )}
                        </div>
                      ) : suggested ? (
                        <span className="text-xs text-slate-700">
                          {suggested.code} — {suggested.name}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-500">—</span>
                      )}
                      {txn.suggestedReason && isPostable && (
                        <p className="mt-0.5 max-w-xs truncate text-xs text-slate-500">
                          {txn.suggestedReason}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_COLOR[txn.status]}`}
                      >
                        {t(`txnStatus.${txn.status}`)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isPostable && (
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => postMutation.mutate({ id: txn.id })}
                            disabled={!txn.suggestedAccountId || postMutation.isPending}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-30"
                          >
                            {t('list.post')}
                          </button>
                          <button
                            type="button"
                            onClick={() => ignoreMutation.mutate(txn.id)}
                            disabled={ignoreMutation.isPending}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-30"
                          >
                            {t('list.ignore')}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {postMutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {t('list.postFailed', { error: formatError(postMutation.error, t) })}
        </div>
      )}
      {ignoreMutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {t('list.ignoreFailed', { error: formatError(ignoreMutation.error, t) })}
        </div>
      )}
        </>
      )}
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
