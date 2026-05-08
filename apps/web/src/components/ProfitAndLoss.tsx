import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface PnlSection {
  accountId: string;
  code: string;
  name: string;
  amount: string;
}

interface ProfitAndLossResponse {
  start: string;
  end: string;
  basis: 'accrual' | 'cash';
  revenue: PnlSection[];
  expenses: PnlSection[];
  totalRevenue: string;
  totalExpenses: string;
  netIncome: string;
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const firstOfYear = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-01-01`;
};

function formatUsd(s: string): string {
  if (!s) return '$0.00';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

export function ProfitAndLoss() {
  const { companyId } = useCurrentCompany();
  const [start, setStart] = useState<string>(firstOfYear);
  const [end, setEnd] = useState<string>(todayIso);
  const [basis, setBasis] = useState<'accrual' | 'cash'>('accrual');

  const query = useQuery({
    queryKey: ['pnl', companyId, start, end, basis],
    enabled: Boolean(companyId) && Boolean(start) && Boolean(end),
    queryFn: () =>
      api<ProfitAndLossResponse>(
        `/ledger/reports/pnl?start=${start}&end=${end}&basis=${basis}`,
        { companyId },
      ),
  });

  const data = query.data;

  const sortedRevenue = useMemo(
    () => (data?.revenue ?? []).slice().sort((a, b) => a.code.localeCompare(b.code)),
    [data],
  );
  const sortedExpenses = useMemo(
    () => (data?.expenses ?? []).slice().sort((a, b) => a.code.localeCompare(b.code)),
    [data],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From">
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Basis">
          <select
            value={basis}
            onChange={(e) => setBasis(e.target.value as 'accrual' | 'cash')}
            className={inputClass}
          >
            <option value="accrual">Accrual</option>
            <option value="cash">Cash</option>
          </select>
        </Field>
      </div>

      {query.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : 'Failed to load P&L.'}
        </p>
      )}

      {data && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Code</th>
                <th className="px-4 py-2 text-left font-medium">Account</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              <tr className="bg-slate-50">
                <td colSpan={3} className="px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-slate-500">
                  Revenue
                </td>
              </tr>
              {sortedRevenue.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-2 text-slate-500">No revenue in this range.</td>
                </tr>
              ) : (
                sortedRevenue.map((r) => (
                  <tr key={r.accountId}>
                    <td className="px-4 py-2 font-mono text-slate-500">{r.code}</td>
                    <td className="px-4 py-2 text-slate-900">{r.name}</td>
                    <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(r.amount)}</td>
                  </tr>
                ))
              )}
              <tr className="bg-slate-50 font-medium">
                <td colSpan={2} className="px-4 py-2 text-right text-slate-700">Total revenue</td>
                <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(data.totalRevenue)}</td>
              </tr>

              <tr className="bg-slate-50">
                <td colSpan={3} className="px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-slate-500">
                  Expenses
                </td>
              </tr>
              {sortedExpenses.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-2 text-slate-500">No expenses in this range.</td>
                </tr>
              ) : (
                sortedExpenses.map((r) => (
                  <tr key={r.accountId}>
                    <td className="px-4 py-2 font-mono text-slate-500">{r.code}</td>
                    <td className="px-4 py-2 text-slate-900">{r.name}</td>
                    <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(r.amount)}</td>
                  </tr>
                ))
              )}
              <tr className="bg-slate-50 font-medium">
                <td colSpan={2} className="px-4 py-2 text-right text-slate-700">Total expenses</td>
                <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(data.totalExpenses)}</td>
              </tr>
            </tbody>
            <tfoot className="bg-slate-100 text-sm font-semibold">
              <tr>
                <td colSpan={2} className="px-4 py-3 text-right text-slate-900">
                  Net income ({data.basis} basis)
                </td>
                <td
                  className={
                    'px-4 py-3 text-right font-mono ' +
                    (Number(data.netIncome) >= 0 ? 'text-emerald-700' : 'text-rose-700')
                  }
                >
                  {formatUsd(data.netIncome)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

const inputClass =
  'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-slate-900 focus:outline-none';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm text-slate-600">
      <span>{label}</span>
      {children}
    </label>
  );
}
