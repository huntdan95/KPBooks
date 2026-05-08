import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface AgingRow {
  counterpartyId: string;
  counterpartyName: string;
  current: string;
  days1to30: string;
  days31to60: string;
  days61to90: string;
  days91plus: string;
  total: string;
}

interface AgingResponse {
  asOf: string;
  rows: AgingRow[];
  totals: Omit<AgingRow, 'counterpartyId' | 'counterpartyName'>;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

function formatUsd(s: string): string {
  if (!s || s === '0' || Number(s) === 0) return '—';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

function formatTotal(s: string): string {
  if (!s) return '$0.00';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

/**
 * Reusable aging table — A/R Aging passes mode="ar", A/P Aging passes
 * mode="ap". The endpoint, the counterparty label, and the empty-state text
 * are the only differences.
 */
export function Aging({ mode }: { mode: 'ar' | 'ap' }) {
  const { companyId } = useCurrentCompany();
  const [asOf, setAsOf] = useState<string>(todayIso);

  const path = mode === 'ar' ? '/ledger/reports/ar-aging' : '/ledger/reports/ap-aging';
  const queryKey = mode === 'ar' ? 'ar-aging' : 'ap-aging';
  const counterpartyLabel = mode === 'ar' ? 'Customer' : 'Vendor';
  const emptyMsg =
    mode === 'ar'
      ? 'No open receivables as of this date.'
      : 'No open payables as of this date.';

  const query = useQuery({
    queryKey: [queryKey, companyId, asOf],
    enabled: Boolean(companyId) && Boolean(asOf),
    queryFn: () => api<AgingResponse>(`${path}?asOf=${asOf}`, { companyId }),
  });

  const data = query.data;

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3">
        <Field label="As of">
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      {query.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : 'Failed to load aging report.'}
        </p>
      )}

      {data && data.rows.length === 0 && (
        <p className="text-sm text-slate-500">{emptyMsg}</p>
      )}

      {data && data.rows.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">{counterpartyLabel}</th>
                <th className="px-4 py-2 text-right font-medium">Current</th>
                <th className="px-4 py-2 text-right font-medium">1–30</th>
                <th className="px-4 py-2 text-right font-medium">31–60</th>
                <th className="px-4 py-2 text-right font-medium">61–90</th>
                <th className="px-4 py-2 text-right font-medium">90+</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {data.rows.map((r) => (
                <tr key={r.counterpartyId}>
                  <td className="px-4 py-2 text-slate-900">{r.counterpartyName}</td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">
                    {formatUsd(r.current)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">
                    {formatUsd(r.days1to30)}
                  </td>
                  <td
                    className={
                      'px-4 py-2 text-right font-mono ' +
                      (Number(r.days31to60) > 0 ? 'text-amber-700' : 'text-slate-700')
                    }
                  >
                    {formatUsd(r.days31to60)}
                  </td>
                  <td
                    className={
                      'px-4 py-2 text-right font-mono ' +
                      (Number(r.days61to90) > 0 ? 'text-orange-700' : 'text-slate-700')
                    }
                  >
                    {formatUsd(r.days61to90)}
                  </td>
                  <td
                    className={
                      'px-4 py-2 text-right font-mono ' +
                      (Number(r.days91plus) > 0 ? 'text-rose-700 font-semibold' : 'text-slate-700')
                    }
                  >
                    {formatUsd(r.days91plus)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono font-medium text-slate-900">
                    {formatTotal(r.total)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-100 text-sm font-semibold">
              <tr>
                <td className="px-4 py-2 text-right text-slate-900">Totals</td>
                <td className="px-4 py-2 text-right font-mono">{formatTotal(data.totals.current)}</td>
                <td className="px-4 py-2 text-right font-mono">{formatTotal(data.totals.days1to30)}</td>
                <td className="px-4 py-2 text-right font-mono">{formatTotal(data.totals.days31to60)}</td>
                <td className="px-4 py-2 text-right font-mono">{formatTotal(data.totals.days61to90)}</td>
                <td className="px-4 py-2 text-right font-mono">{formatTotal(data.totals.days91plus)}</td>
                <td className="px-4 py-2 text-right font-mono">{formatTotal(data.totals.total)}</td>
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
