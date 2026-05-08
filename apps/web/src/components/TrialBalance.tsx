import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subtype: string;
  debit: string;
  credit: string;
  balance: string;
}

const TYPE_LABEL: Record<TrialBalanceRow['type'], string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expense',
};

const today = () => new Date().toISOString().slice(0, 10);

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
  if (!s) return '';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

const ORDER: TrialBalanceRow['type'][] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

export function TrialBalance() {
  const { companyId } = useCurrentCompany();
  const [asOf, setAsOf] = useState<string>(today);

  const query = useQuery({
    queryKey: ['trial-balance', companyId, asOf],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ asOf: string; rows: TrialBalanceRow[] }>(
        `/ledger/reports/trial-balance?asOf=${asOf}`,
        { companyId },
      ),
  });

  const rows = useMemo(() => {
    const all = query.data?.rows ?? [];
    return [...all].sort((a, b) => a.code.localeCompare(b.code));
  }, [query.data]);

  const totals = useMemo(() => {
    let debit = '0';
    let credit = '0';
    for (const r of rows) {
      debit = addCents(debit, r.debit);
      credit = addCents(credit, r.credit);
    }
    return { debit, credit };
  }, [rows]);

  const balanced = totals.debit === totals.credit;

  const grouped = useMemo(() => {
    const map: Partial<Record<TrialBalanceRow['type'], TrialBalanceRow[]>> = {};
    for (const r of rows) {
      (map[r.type] ??= []).push(r);
    }
    return map;
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Trial Balance</h2>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          As of
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-slate-900 focus:outline-none"
          />
        </label>
      </div>

      {query.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : 'Failed to load trial balance.'}
        </p>
      )}

      {query.data && rows.length === 0 && (
        <p className="text-sm text-slate-500">
          No activity through {asOf}. Post a journal entry to see balances here.
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Code</th>
                <th className="px-4 py-2 text-left font-medium">Account</th>
                <th className="px-4 py-2 text-right font-medium">Debit</th>
                <th className="px-4 py-2 text-right font-medium">Credit</th>
                <th className="px-4 py-2 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {ORDER.flatMap((type) => {
                const group = grouped[type];
                if (!group?.length) return [];
                return [
                  <tr key={`hdr-${type}`} className="bg-slate-50">
                    <td colSpan={5} className="px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-slate-500">
                      {TYPE_LABEL[type]}
                    </td>
                  </tr>,
                  ...group.map((r) => (
                    <tr key={r.accountId}>
                      <td className="px-4 py-2 font-mono text-slate-500">{r.code}</td>
                      <td className="px-4 py-2 text-slate-900">{r.name}</td>
                      <td className="px-4 py-2 text-right font-mono text-slate-900">
                        {Number(r.debit) > 0 ? formatUsd(r.debit) : ''}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-slate-900">
                        {Number(r.credit) > 0 ? formatUsd(r.credit) : ''}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-slate-700">
                        {formatUsd(r.balance)}
                      </td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
            <tfoot className="bg-slate-50 text-sm font-medium">
              <tr>
                <td colSpan={2} className="px-4 py-2 text-right text-slate-600">
                  Totals
                </td>
                <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(totals.debit)}</td>
                <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(totals.credit)}</td>
                <td className="px-4 py-2 text-right">
                  <span className={balanced ? 'text-emerald-600' : 'text-rose-600'}>
                    {balanced ? '✓ balanced' : '✗ unbalanced'}
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
