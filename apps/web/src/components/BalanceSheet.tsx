import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface Section {
  accountId: string;
  code: string;
  name: string;
  amount: string;
}

interface BalanceSheetResponse {
  asOf: string;
  assets: Section[];
  liabilities: Section[];
  equity: Section[];
  totalAssets: string;
  totalLiabilities: string;
  totalEquity: string;
  imbalance: string;
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

export function BalanceSheet() {
  const { companyId } = useCurrentCompany();
  const [asOf, setAsOf] = useState<string>(todayIso);

  const query = useQuery({
    queryKey: ['balance-sheet', companyId, asOf],
    enabled: Boolean(companyId) && Boolean(asOf),
    queryFn: () =>
      api<BalanceSheetResponse>(
        `/ledger/reports/balance-sheet?asOf=${asOf}`,
        { companyId },
      ),
  });

  const data = query.data;

  const sortedAssets = useMemo(
    () => (data?.assets ?? []).slice().sort((a, b) => a.code.localeCompare(b.code)),
    [data],
  );
  const sortedLiabilities = useMemo(
    () => (data?.liabilities ?? []).slice().sort((a, b) => a.code.localeCompare(b.code)),
    [data],
  );
  const sortedEquity = useMemo(
    () => (data?.equity ?? []).slice().sort((a, b) => a.code.localeCompare(b.code)),
    [data],
  );

  const balanced = data ? Number(data.imbalance) === 0 : true;

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
          {query.error instanceof Error ? query.error.message : 'Failed to load balance sheet.'}
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
              <SectionRows label="Assets" rows={sortedAssets} total={data.totalAssets} />
              <SectionRows
                label="Liabilities"
                rows={sortedLiabilities}
                total={data.totalLiabilities}
              />
              <SectionRows label="Equity" rows={sortedEquity} total={data.totalEquity} />
            </tbody>
            <tfoot className="bg-slate-100 text-sm font-semibold">
              <tr>
                <td colSpan={2} className="px-4 py-3 text-right text-slate-900">
                  Liabilities + Equity
                </td>
                <td className="px-4 py-3 text-right font-mono text-slate-900">
                  {formatUsd(
                    addStr(data.totalLiabilities, data.totalEquity),
                  )}
                </td>
              </tr>
              {!balanced && (
                <tr>
                  <td colSpan={2} className="px-4 py-2 text-right text-rose-700">
                    Imbalance (assets − (liabilities + equity))
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-rose-700">
                    {formatUsd(data.imbalance)}
                  </td>
                </tr>
              )}
              {balanced && (
                <tr>
                  <td colSpan={3} className="px-4 py-2 text-right text-emerald-700">
                    ✓ Balanced
                  </td>
                </tr>
              )}
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function SectionRows({
  label,
  rows,
  total,
}: {
  label: string;
  rows: Section[];
  total: string;
}) {
  return (
    <>
      <tr className="bg-slate-50">
        <td colSpan={3} className="px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-slate-500">
          {label}
        </td>
      </tr>
      {rows.length === 0 ? (
        <tr>
          <td colSpan={3} className="px-4 py-2 text-slate-500">
            No {label.toLowerCase()} balances as of this date.
          </td>
        </tr>
      ) : (
        rows.map((r) => (
          <tr key={r.accountId}>
            <td className="px-4 py-2 font-mono text-slate-500">{r.code}</td>
            <td className="px-4 py-2 text-slate-900">{r.name}</td>
            <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(r.amount)}</td>
          </tr>
        ))
      )}
      <tr className="bg-slate-50 font-medium">
        <td colSpan={2} className="px-4 py-2 text-right text-slate-700">
          Total {label.toLowerCase()}
        </td>
        <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(total)}</td>
      </tr>
    </>
  );
}

// Local 4-dp string add — same precision as the server-side Money.
function addStr(a: string, b: string): string {
  const toMicros = (s: string) => {
    if (!s) return 0n;
    const [whole = '0', frac = ''] = s.split('.');
    const padded = (frac + '0000').slice(0, 4);
    const sign = whole.startsWith('-') ? -1n : 1n;
    const wholeAbs = whole.replace(/^-/, '');
    return sign * (BigInt(wholeAbs || '0') * 10000n + BigInt(padded || '0'));
  };
  const sum = toMicros(a) + toMicros(b);
  const negative = sum < 0n;
  const abs = negative ? -sum : sum;
  const whole = abs / 10000n;
  const frac = abs % 10000n;
  return `${negative ? '-' : ''}${whole}.${String(frac).padStart(4, '0')}`;
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
