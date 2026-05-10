import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface RateRow {
  taxRateId: string;
  name: string;
  ratePercent: string;
  isActive: boolean;
  invoiceCount: number;
  taxableSales: string;
  taxCollected: string;
}

interface SalesTaxLiabilityResp {
  from: string;
  to: string;
  account: { id: string; code: string; name: string } | null;
  collected: string;
  remitted: string;
  netChange: string;
  endingBalance: string;
  byRate: RateRow[];
  untracked: { invoiceCount: number; taxCollected: string };
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);
const firstOfQuarter = (): string => {
  const d = new Date();
  const q = Math.floor(d.getUTCMonth() / 3);
  return `${d.getUTCFullYear()}-${String(q * 3 + 1).padStart(2, '0')}-01`;
};

function formatUsd(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === '') return '$0.00';
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function SalesTaxLiability() {
  const { companyId } = useCurrentCompany();
  const [from, setFrom] = useState<string>(firstOfQuarter);
  const [to, setTo] = useState<string>(todayIso);

  const query = useQuery({
    queryKey: ['sales-tax-liability', companyId, from, to],
    enabled: Boolean(companyId) && Boolean(from) && Boolean(to),
    queryFn: () =>
      api<SalesTaxLiabilityResp>(
        `/ledger/reports/sales-tax-liability?from=${from}&to=${to}`,
        { companyId },
      ),
  });

  const data = query.data;
  const netChangeNum = data ? Number(data.netChange) : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      <p className="text-xs text-slate-500">
        What you owe each tax jurisdiction. <strong>Collected</strong> = sales tax credited to
        the "Sales Tax Payable" account on posted invoices. <strong>Remitted</strong> = debits
        to the same account (your remittance payments + adjustments).{' '}
        <strong>Ending balance</strong> = what's still owed as of the To date. Per-rate breakdown
        comes from non-void invoices billed in the period — fill the columns straight into the
        state/local remittance form.
      </p>

      {query.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : 'Failed to load.'}
        </p>
      )}

      {data && !data.account && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          No account named <code>Sales Tax Payable</code> exists yet. Create one in Chart of
          Accounts (liability / other_current_liability) before invoices with tax can post.
          Per-rate breakdown still works below.
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Tile
              label="Collected (period)"
              value={formatUsd(data.collected)}
              hint={`${data.from} → ${data.to}`}
              tone="slate"
            />
            <Tile
              label="Remitted (period)"
              value={formatUsd(data.remitted)}
              hint="DR to Sales Tax Payable"
              tone="slate"
            />
            <Tile
              label="Net change"
              value={formatUsd(data.netChange)}
              hint={netChangeNum >= 0 ? 'liability grew' : 'liability shrank'}
              tone={netChangeNum > 0 ? 'rose' : 'emerald'}
            />
            <Tile
              label={`Owed as of ${data.to}`}
              value={formatUsd(data.endingBalance)}
              hint="cumulative GL balance"
              tone="slate"
            />
          </div>

          <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Tax rate</th>
                  <th className="px-4 py-2 text-right font-medium">Rate</th>
                  <th className="px-4 py-2 text-right font-medium">Invoices</th>
                  <th className="px-4 py-2 text-right font-medium">Taxable sales</th>
                  <th className="px-4 py-2 text-right font-medium">Tax collected</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {data.byRate.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-6 text-center text-sm text-slate-500"
                    >
                      No active tax rates in this period.
                    </td>
                  </tr>
                )}
                {data.byRate.map((r) => (
                  <tr
                    key={r.taxRateId}
                    className={r.invoiceCount === 0 ? 'opacity-50' : ''}
                  >
                    <td className="px-4 py-2 text-slate-900">
                      {r.name}
                      {!r.isActive && (
                        <span className="ml-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                          inactive
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-slate-600">
                      {Number(r.ratePercent).toFixed(4)}%
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-700">
                      {r.invoiceCount}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-700">
                      {formatUsd(r.taxableSales)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-900">
                      {formatUsd(r.taxCollected)}
                    </td>
                  </tr>
                ))}
                {data.untracked.invoiceCount > 0 && (
                  <tr className="bg-amber-50/50">
                    <td className="px-4 py-2 text-slate-900">
                      <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-800 ring-1 ring-amber-200">
                        no rate linked
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-slate-400">—</td>
                    <td className="px-4 py-2 text-right font-mono text-slate-700">
                      {data.untracked.invoiceCount}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-slate-400">—</td>
                    <td className="px-4 py-2 text-right font-mono text-slate-900">
                      {formatUsd(data.untracked.taxCollected)}
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot className="bg-slate-100 text-sm font-semibold">
                <tr>
                  <td colSpan={3} className="px-4 py-3 text-right text-slate-900">
                    Period total (invoices billed)
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-700">
                    {formatUsd(
                      data.byRate.reduce((acc, r) => acc + Number(r.taxableSales), 0),
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-900">
                    {formatUsd(
                      data.byRate.reduce((acc, r) => acc + Number(r.taxCollected), 0) +
                        Number(data.untracked.taxCollected),
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="text-xs text-slate-500">
            <strong>Tip:</strong> the period total of "Tax collected" should match the GL
            "Collected" tile above. If they diverge, look for manual journal entries that hit
            Sales Tax Payable directly — those bypass the per-rate breakdown.
          </p>
        </>
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone: 'slate' | 'emerald' | 'rose';
}) {
  const cls = {
    slate: 'border-slate-200 bg-white text-slate-900',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    rose: 'border-rose-200 bg-rose-50 text-rose-700',
  }[tone];
  return (
    <div className={'rounded-md border p-3 ' + cls}>
      <div className="text-xs uppercase tracking-wider opacity-70">{label}</div>
      <div className="mt-1 font-mono text-xl">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] opacity-60">{hint}</div>}
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
