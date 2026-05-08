import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { BankRules } from './BankRules';
import { Reconcile } from './Reconcile';

type BankTxnStatus = 'unmatched' | 'suggested' | 'posted' | 'ignored';
type Confidence = 'high' | 'medium' | 'low';

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
      if (!selectedBankAccountId) throw new Error('Pick a bank account first.');
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
      setImportError(formatError(err));
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
      setImportError('Pick a bank account first.');
      return;
    }
    if (file.size > 2_000_000) {
      setImportError(`File is ${(file.size / 1e6).toFixed(1)} MB; limit is 2 MB.`);
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

  const unmatchedCount = txns.filter((t) => t.status === 'unmatched').length;
  const aiAvailable = aiStatusQuery.data?.available ?? false;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Banking</h2>
          <p className="text-sm text-slate-500">
            Import a bank or credit-card CSV statement, categorize each line (Claude can suggest),
            then reconcile against the bank's monthly statement.
          </p>
        </div>
        <div className="flex gap-1 border-b border-slate-200">
          {(
            [
              { id: 'transactions', label: 'Transactions' },
              { id: 'reconcile', label: 'Reconcile' },
              { id: 'rules', label: 'Rules' },
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
                {tab.label}
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
            <span>Bank account</span>
            <select
              value={selectedBankAccountId}
              onChange={(e) => setSelectedBankAccountId(e.target.value)}
              className={inputClass}
            >
              <option value="">— select —</option>
              {bankAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name} ({a.subtype.replace(/_/g, ' ')})
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
            {importMutation.isPending ? 'Importing…' : 'Import CSV'}
          </button>
        </div>
        {importResult && (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
            Imported {importResult.imported} new
            {importResult.duplicates > 0 ? `, skipped ${importResult.duplicates} duplicate(s)` : ''}
            {importResult.ruleMatched > 0
              ? `, ${importResult.ruleMatched} pre-categorized by rules`
              : ''}
            .
            {importResult.warnings.length > 0 && (
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer">{importResult.warnings.length} parser warnings</summary>
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
        <p className="text-xs text-slate-500">
          Most bank CSV exports work out of the box (Wells Fargo, Chase, BofA, Capital One). The
          parser auto-detects Date / Description / Amount or Debit+Credit columns.
        </p>
      </section>

      {/* ----------- Filter + AI categorize batch ------------- */}
      <section className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm text-slate-600">
          <span>Status</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as BankTxnStatus | '')}
            className={inputClass}
          >
            <option value="">All</option>
            <option value="unmatched">Unmatched</option>
            <option value="suggested">Suggested</option>
            <option value="posted">Posted</option>
            <option value="ignored">Ignored</option>
          </select>
        </label>

        {aiAvailable ? (
          <button
            type="button"
            onClick={() => {
              const ids =
                selectedIds.size > 0
                  ? Array.from(selectedIds)
                  : txns.filter((t) => t.status === 'unmatched').map((t) => t.id).slice(0, 50);
              if (ids.length === 0) return;
              suggestMutation.mutate(ids);
            }}
            disabled={suggestMutation.isPending || (selectedIds.size === 0 && unmatchedCount === 0)}
            className="rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {suggestMutation.isPending
              ? 'Asking Claude…'
              : selectedIds.size > 0
                ? `Suggest categories (${selectedIds.size} selected)`
                : `Suggest categories for next ${Math.min(unmatchedCount, 50)} unmatched`}
          </button>
        ) : (
          <p className="text-xs text-slate-500">
            AI categorization requires the ANTHROPIC_API_KEY secret to be set in Cloud Run.
          </p>
        )}

        {suggestResult && (
          <p className="text-xs text-slate-600">
            ✓ Suggested {suggestResult.updated}
            {suggestResult.failed > 0 ? `; failed ${suggestResult.failed}` : ''}
            {suggestResult.errors.length > 0 ? ` (${suggestResult.errors[0]})` : ''}
          </p>
        )}

        {suggestMutation.isError && (
          <p className="text-xs text-rose-600">
            AI: {formatError(suggestMutation.error)}
          </p>
        )}
      </section>

      {/* ----------- Transactions table ------------- */}
      {txnsQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {!txnsQuery.isLoading && txns.length === 0 && (
        <p className="text-sm text-slate-500">No transactions match this filter.</p>
      )}
      {txns.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="w-10 px-3 py-2"></th>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Description</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-left font-medium">Suggested account</th>
                <th className="px-3 py-2 text-center font-medium">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {txns.map((t) => {
                const suggested = t.suggestedAccountId ? accountById.get(t.suggestedAccountId) : null;
                const isPostable = t.status === 'unmatched' || t.status === 'suggested';
                return (
                  <tr key={t.id} className={t.status === 'ignored' ? 'opacity-60' : ''}>
                    <td className="px-3 py-2 text-center">
                      {isPostable && (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(t.id)}
                          onChange={() => toggleSelect(t.id)}
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-slate-700">{t.transactionDate}</td>
                    <td className="px-3 py-2 text-slate-900">{t.description}</td>
                    <td
                      className={
                        'px-3 py-2 text-right font-mono ' +
                        (t.amount.startsWith('-') ? 'text-rose-700' : 'text-emerald-700')
                      }
                    >
                      {formatUsd(t.amount)}
                    </td>
                    <td className="px-3 py-2">
                      {isPostable ? (
                        <div className="flex items-center gap-2">
                          <select
                            value={t.suggestedAccountId ?? ''}
                            onChange={(e) => {
                              postMutation.mutate({ id: t.id, accountId: e.target.value });
                            }}
                            disabled={postMutation.isPending}
                            className="max-w-xs rounded-md border border-slate-300 bg-white px-2 py-1 text-xs focus:border-slate-900 focus:outline-none"
                          >
                            <option value="">— select & post —</option>
                            {allActiveAccounts.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.code} — {a.name}
                              </option>
                            ))}
                          </select>
                          {t.suggestedConfidence && (
                            <span
                              className={
                                'text-xs ' + CONFIDENCE_COLOR[t.suggestedConfidence]
                              }
                              title={t.suggestedReason ?? ''}
                            >
                              {t.suggestedConfidence}
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
                      {t.suggestedReason && isPostable && (
                        <p className="mt-0.5 max-w-xs truncate text-xs text-slate-500">
                          {t.suggestedReason}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_COLOR[t.status]}`}
                      >
                        {t.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {isPostable && (
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => postMutation.mutate({ id: t.id })}
                            disabled={!t.suggestedAccountId || postMutation.isPending}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-30"
                          >
                            Post
                          </button>
                          <button
                            type="button"
                            onClick={() => ignoreMutation.mutate(t.id)}
                            disabled={ignoreMutation.isPending}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-30"
                          >
                            Ignore
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
          Post failed: {formatError(postMutation.error)}
        </div>
      )}
      {ignoreMutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          Ignore failed: {formatError(ignoreMutation.error)}
        </div>
      )}
        </>
      )}
    </div>
  );
}

const inputClass =
  'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-slate-900 focus:outline-none';

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? 'Error'}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : 'Operation failed.';
}
