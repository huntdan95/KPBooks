import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  isActive: boolean;
}

interface LineDraft {
  accountId: string;
  side: 'debit' | 'credit';
  amount: string;
  memo: string;
}

interface PostEntryResponse {
  id: string;
  entryDate: string;
  sourceType: string;
  lineCount: number;
}

const today = () => new Date().toISOString().slice(0, 10);

const blankLine = (): LineDraft => ({ accountId: '', side: 'debit', amount: '', memo: '' });

// Sums two decimal-string amounts to 4 dp without floating-point drift. The server
// stores NUMERIC(19,4); doing the math as fixed-point integers keeps the UI total
// exactly aligned with what the deferred balance trigger will check at COMMIT.
function addCents(a: string, b: string): string {
  const toMicros = (s: string) => {
    if (!s) return 0n;
    const [whole, frac = ''] = s.replace(/,/g, '').split('.');
    const padded = (frac + '0000').slice(0, 4);
    return BigInt(whole || '0') * 10000n + BigInt(padded || '0');
  };
  const sum = toMicros(a) + toMicros(b);
  const negative = sum < 0n;
  const abs = negative ? -sum : sum;
  const whole = abs / 10000n;
  const frac = abs % 10000n;
  return `${negative ? '-' : ''}${whole}.${String(frac).padStart(4, '0')}`;
}

function formatUsd(s: string): string {
  if (!s || s === '0.0000') return '$0.00';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

export function JournalEntryForm() {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();

  const accountsQuery = useQuery({
    queryKey: ['accounts', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ accounts: Account[] }>('/ledger/accounts', { companyId }),
  });
  const accounts = useMemo(
    () => (accountsQuery.data?.accounts ?? []).filter((a) => a.isActive).sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQuery.data],
  );

  const [entryDate, setEntryDate] = useState<string>(today);
  const [memo, setMemo] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([blankLine(), blankLine()]);
  const [postedId, setPostedId] = useState<string | null>(null);

  function updateLine(idx: number, patch: Partial<LineDraft>) {
    setLines((current) => current.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((current) => [...current, blankLine()]);
  }
  function removeLine(idx: number) {
    setLines((current) => (current.length <= 2 ? current : current.filter((_, i) => i !== idx)));
  }
  function resetForm() {
    setEntryDate(today());
    setMemo('');
    setReference('');
    setLines([blankLine(), blankLine()]);
    setPostedId(null);
  }

  const totals = useMemo(() => {
    let debit = '0';
    let credit = '0';
    for (const l of lines) {
      if (!l.amount) continue;
      if (l.side === 'debit') debit = addCents(debit, l.amount);
      else credit = addCents(credit, l.amount);
    }
    return { debit, credit, diff: addCents(debit, '-' + credit.replace(/^-/, '')) };
  }, [lines]);

  const balanced = totals.diff === '0.0000';
  const allLinesValid = lines.every((l) => l.accountId && l.amount && Number(l.amount) > 0);
  const canSubmit = balanced && allLinesValid && lines.length >= 2;

  const mutation = useMutation({
    mutationFn: async () =>
      api<PostEntryResponse>('/ledger/journal-entries', {
        method: 'POST',
        companyId,
        body: {
          entryDate,
          sourceType: 'manual',
          memo: memo.trim() || undefined,
          reference: reference.trim() || undefined,
          lines: lines.map((l) => ({
            accountId: l.accountId,
            ...(l.side === 'debit' ? { debit: l.amount } : { credit: l.amount }),
            currency: 'USD',
            fxRate: '1',
            memo: l.memo.trim() || undefined,
          })),
        },
      }),
    onSuccess: (data) => {
      setPostedId(data.id);
      // Invalidate the trial-balance cache so the next visit shows the new entry.
      void queryClient.invalidateQueries({ queryKey: ['trial-balance', companyId] });
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || mutation.isPending) return;
    setPostedId(null);
    mutation.mutate();
  }

  if (accountsQuery.isLoading) {
    return <p className="text-sm text-slate-500">Loading accounts…</p>;
  }
  if (accounts.length === 0) {
    return (
      <p className="text-sm text-slate-500">
        No active accounts to post against. Create accounts first.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">New Journal Entry</h2>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-700">Date</span>
          <input
            type="date"
            value={entryDate}
            onChange={(e) => setEntryDate(e.target.value)}
            required
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          />
        </label>
        <label className="block space-y-1 sm:col-span-2">
          <span className="text-sm font-medium text-slate-700">Memo</span>
          <input
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            maxLength={500}
            placeholder="Optional"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          />
        </label>
        <label className="block space-y-1 sm:col-span-3">
          <span className="text-sm font-medium text-slate-700">Reference</span>
          <input
            type="text"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            maxLength={120}
            placeholder="Optional — invoice #, check #, etc."
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          />
        </label>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-700">Lines</h3>
          <button
            type="button"
            onClick={addLine}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100"
          >
            + Add line
          </button>
        </div>
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Account</th>
                <th className="px-3 py-2 text-left font-medium">Side</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 text-left font-medium">Memo</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {lines.map((line, idx) => (
                <tr key={idx}>
                  <td className="px-3 py-2">
                    <select
                      value={line.accountId}
                      onChange={(e) => updateLine(idx, { accountId: e.target.value })}
                      className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
                      required
                    >
                      <option value="">— select account —</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={line.side}
                      onChange={(e) => updateLine(idx, { side: e.target.value as 'debit' | 'credit' })}
                      className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
                    >
                      <option value="debit">Debit</option>
                      <option value="credit">Credit</option>
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={line.amount}
                      onChange={(e) => updateLine(idx, { amount: e.target.value.replace(/[^0-9.]/g, '') })}
                      placeholder="0.00"
                      className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-right font-mono text-sm focus:border-slate-900 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={line.memo}
                      onChange={(e) => updateLine(idx, { memo: e.target.value })}
                      maxLength={500}
                      placeholder="Optional"
                      className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => removeLine(idx)}
                      disabled={lines.length <= 2}
                      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-30"
                      aria-label="Remove line"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 text-sm">
              <tr className="font-medium">
                <td className="px-3 py-2 text-right text-slate-600" colSpan={2}>
                  Totals
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-900">
                  Dr {formatUsd(totals.debit)} / Cr {formatUsd(totals.credit)}
                </td>
                <td className="px-3 py-2 font-mono" colSpan={2}>
                  <span className={balanced ? 'text-emerald-600' : 'text-rose-600'}>
                    {balanced ? '✓ balanced' : `off by ${formatUsd(totals.diff)}`}
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!canSubmit || mutation.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation.isPending ? 'Posting…' : 'Post entry'}
        </button>
        <button
          type="button"
          onClick={resetForm}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
        >
          Reset
        </button>
        {!balanced && lines.some((l) => l.amount) && (
          <span className="text-xs text-slate-500">Debits must equal credits.</span>
        )}
      </div>

      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {(() => {
            const err = mutation.error;
            if (err instanceof ApiError) {
              const body = err.body as { error?: string; message?: string } | null;
              if (body?.message) return `${body.error ?? 'Error'}: ${body.message}`;
            }
            return err instanceof Error ? err.message : 'Failed to post entry.';
          })()}
        </div>
      )}

      {postedId && !mutation.isError && (
        <div className="flex items-center justify-between rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          <span>
            ✓ Posted entry <span className="font-mono">#{postedId.slice(0, 8)}</span>.
          </span>
          <button
            type="button"
            onClick={resetForm}
            className="rounded-md border border-emerald-300 bg-white px-3 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
          >
            Post another
          </button>
        </div>
      )}
    </form>
  );
}
