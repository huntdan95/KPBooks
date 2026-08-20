import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { reportFilename } from '../lib/report-export';
import { type CsvRow, ExportCsvButton, csvMoney } from './ReportExport';

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

// Local 4-dp string add — same precision as the server-side Money. The period
// totals used to accumulate through Number(), which drifts a cent on a long
// rate list and would then be truncated to the wrong cent in the CSV.
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

export function SalesTaxLiability() {
  const { t } = useTranslation(['reports', 'common']);
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

  // Footer totals, in minor units so screen and CSV agree to the cent.
  const periodTotals = useMemo(() => {
    let taxableSales = '0';
    let taxCollected = '0';
    for (const r of data?.byRate ?? []) {
      taxableSales = addStr(taxableSales, r.taxableSales);
      taxCollected = addStr(taxCollected, r.taxCollected);
    }
    if (data) taxCollected = addStr(taxCollected, data.untracked.taxCollected);
    return { taxableSales, taxCollected };
  }, [data]);

  /** The four tiles, then the per-rate table exactly as rendered. */
  function csvRows(): CsvRow[] {
    if (!data) return [];
    const out: CsvRow[] = [
      // The tiles carry numbers the table does not — remitted and the ending
      // GL balance are the whole point of the report at filing time.
      [t('salesTax.tiles.collected'), csvMoney(data.collected)],
      [t('salesTax.tiles.remitted'), csvMoney(data.remitted)],
      [t('salesTax.tiles.netChange'), csvMoney(data.netChange)],
      [t('salesTax.tiles.owed', { date: data.to }), csvMoney(data.endingBalance)],
      [],
      [
        t('salesTax.columns.taxRate'),
        t('salesTax.columns.rate'),
        t('salesTax.columns.invoices'),
        t('salesTax.columns.taxableSales'),
        t('salesTax.columns.taxCollected'),
      ],
    ];
    if (data.byRate.length === 0) out.push([t('salesTax.noRates')]);
    for (const r of data.byRate) {
      out.push([
        r.isActive ? r.name : `${r.name} ${t('accounts.inactiveTag')}`,
        Number(r.ratePercent).toFixed(4),
        r.invoiceCount,
        csvMoney(r.taxableSales),
        csvMoney(r.taxCollected),
      ]);
    }
    if (data.untracked.invoiceCount > 0) {
      out.push([
        t('salesTax.noRateLinked'),
        '',
        data.untracked.invoiceCount,
        '',
        csvMoney(data.untracked.taxCollected),
      ]);
    }
    out.push([
      t('salesTax.periodTotal'),
      '',
      '',
      csvMoney(periodTotals.taxableSales),
      csvMoney(periodTotals.taxCollected),
    ]);
    return out;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('common:from')}>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label={t('common:to')}>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={inputClass}
          />
        </Field>
        <ExportCsvButton
          filename={reportFilename('sales-tax-liability', data?.from, data?.to)}
          meta={{
            title: t('tabs.salesTaxLiability'),
            ...(data ? { start: data.from, end: data.to } : {}),
          }}
          rows={csvRows}
          disabled={query.isLoading || !data}
        />
      </div>

      <p className="text-xs text-slate-500">
        <Trans ns="reports" i18nKey="salesTax.help" components={{ b: <strong /> }} />
      </p>

      {query.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : t('salesTax.loadError')}
        </p>
      )}

      {data && !data.account && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <Trans ns="reports" i18nKey="salesTax.noAccount" components={{ code: <code /> }} />
        </div>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Tile
              label={t('salesTax.tiles.collected')}
              value={formatUsd(data.collected)}
              hint={`${data.from} → ${data.to}`}
              tone="slate"
            />
            <Tile
              label={t('salesTax.tiles.remitted')}
              value={formatUsd(data.remitted)}
              hint={t('salesTax.tiles.remittedHint')}
              tone="slate"
            />
            <Tile
              label={t('salesTax.tiles.netChange')}
              value={formatUsd(data.netChange)}
              hint={
                netChangeNum >= 0
                  ? t('salesTax.tiles.liabilityGrew')
                  : t('salesTax.tiles.liabilityShrank')
              }
              tone={netChangeNum > 0 ? 'rose' : 'emerald'}
            />
            <Tile
              label={t('salesTax.tiles.owed', { date: data.to })}
              value={formatUsd(data.endingBalance)}
              hint={t('salesTax.tiles.owedHint')}
              tone="slate"
            />
          </div>

          <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">
                    {t('salesTax.columns.taxRate')}
                  </th>
                  <th className="px-4 py-2 text-right font-medium">{t('salesTax.columns.rate')}</th>
                  <th className="px-4 py-2 text-right font-medium">
                    {t('salesTax.columns.invoices')}
                  </th>
                  <th className="px-4 py-2 text-right font-medium">
                    {t('salesTax.columns.taxableSales')}
                  </th>
                  <th className="px-4 py-2 text-right font-medium">
                    {t('salesTax.columns.taxCollected')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {data.byRate.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-6 text-center text-sm text-slate-500"
                    >
                      {t('salesTax.noRates')}
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
                          {t('salesTax.inactive')}
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
                        {t('salesTax.noRateLinked')}
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
                    {t('salesTax.periodTotal')}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-700">
                    {formatUsd(periodTotals.taxableSales)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-900">
                    {formatUsd(periodTotals.taxCollected)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="text-xs text-slate-500">
            <Trans ns="reports" i18nKey="salesTax.tip" components={{ b: <strong /> }} />
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
