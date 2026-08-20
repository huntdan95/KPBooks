import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { reportFilename } from '../lib/report-export';
import { type AccountDrillTarget, drillButtonClass, drillRowClass } from './AccountDetail';
import { type CsvRow, ExportCsvButton, csvMoney } from './ReportExport';

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

/**
 * A balance sheet figure is cumulative, so there is no range to hand the
 * drill-down. Open it on the year to date and let the account detail carry the
 * prior years in as its opening balance — the QuickZoom default, and nothing
 * is lost: the detail view has its own From/To if a wider window is wanted.
 */
const yearStartOf = (asOf: string) => `${asOf.slice(0, 4)}-01-01`;

function formatUsd(s: string): string {
  if (!s) return '$0.00';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

export function BalanceSheet({
  onOpenAccount,
}: {
  onOpenAccount?: ((target: AccountDrillTarget) => void) | undefined;
}) {
  const { t } = useTranslation(['reports', 'common']);
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

  /** The table exactly as rendered: three sections, their totals, the footer. */
  function csvRows(): CsvRow[] {
    if (!data) return [];
    const out: CsvRow[] = [[t('code'), t('common:account'), t('common:amount')]];

    const section = (
      name: 'assets' | 'liabilities' | 'equity',
      rows: Section[],
      total: string,
    ) => {
      out.push([t(`balanceSheet.sections.${name}.label`)]);
      if (rows.length === 0) out.push([t(`balanceSheet.sections.${name}.empty`)]);
      for (const r of rows) out.push([r.code, r.name, csvMoney(r.amount)]);
      out.push(['', t(`balanceSheet.sections.${name}.total`), csvMoney(total)]);
    };

    section('assets', sortedAssets, data.totalAssets);
    section('liabilities', sortedLiabilities, data.totalLiabilities);
    section('equity', sortedEquity, data.totalEquity);

    out.push([
      '',
      t('balanceSheet.liabilitiesPlusEquity'),
      csvMoney(addStr(data.totalLiabilities, data.totalEquity)),
    ]);
    out.push(
      balanced
        ? ['', t('balanceSheet.balanced')]
        : ['', t('balanceSheet.imbalance'), csvMoney(data.imbalance)],
    );
    return out;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('common:asOf')}>
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className={inputClass}
          />
        </Field>
        <ExportCsvButton
          filename={reportFilename('balance-sheet', data?.asOf ?? asOf)}
          meta={{ title: t('tabs.balanceSheet'), asOf: data?.asOf ?? asOf }}
          rows={csvRows}
          disabled={query.isLoading || !data}
        />
      </div>

      {query.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : t('balanceSheet.loadError')}
        </p>
      )}

      {data && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">{t('code')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('common:account')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('common:amount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              <SectionRows
                section="assets"
                rows={sortedAssets}
                total={data.totalAssets}
                onOpenAccount={onOpenAccount}
                asOf={data.asOf}
              />
              <SectionRows
                section="liabilities"
                rows={sortedLiabilities}
                total={data.totalLiabilities}
                onOpenAccount={onOpenAccount}
                asOf={data.asOf}
              />
              <SectionRows
                section="equity"
                rows={sortedEquity}
                total={data.totalEquity}
                onOpenAccount={onOpenAccount}
                asOf={data.asOf}
              />
            </tbody>
            <tfoot className="bg-slate-100 text-sm font-semibold">
              <tr>
                <td colSpan={2} className="px-4 py-3 text-right text-slate-900">
                  {t('balanceSheet.liabilitiesPlusEquity')}
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
                    {t('balanceSheet.imbalance')}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-rose-700">
                    {formatUsd(data.imbalance)}
                  </td>
                </tr>
              )}
              {balanced && (
                <tr>
                  <td colSpan={3} className="px-4 py-2 text-right text-emerald-700">
                    {t('balanceSheet.balanced')}
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
  section,
  rows,
  total,
  onOpenAccount,
  asOf,
}: {
  section: 'assets' | 'liabilities' | 'equity';
  rows: Section[];
  total: string;
  onOpenAccount?: ((target: AccountDrillTarget) => void) | undefined;
  asOf: string;
}) {
  const { t } = useTranslation('reports');
  return (
    <>
      <tr className="bg-slate-50">
        <td colSpan={3} className="px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-slate-500">
          {t(`balanceSheet.sections.${section}.label`)}
        </td>
      </tr>
      {rows.length === 0 ? (
        <tr>
          <td colSpan={3} className="px-4 py-2 text-slate-500">
            {t(`balanceSheet.sections.${section}.empty`)}
          </td>
        </tr>
      ) : (
        rows.map((r) => {
          // The whole row is a mouse target so the amount QuickZooms like it
          // does in QuickBooks; the account name is a real <button> so the same
          // drill-down is reachable — and announced — from the keyboard.
          const open = onOpenAccount
            ? () =>
                onOpenAccount({ accountId: r.accountId, start: yearStartOf(asOf), end: asOf })
            : undefined;
          return (
            <tr key={r.accountId} className={open ? drillRowClass : undefined} onClick={open}>
              <td className="px-4 py-2 font-mono text-slate-500">{r.code}</td>
              <td className="px-4 py-2 text-slate-900">
                {open ? (
                  <button
                    type="button"
                    className={drillButtonClass}
                    aria-label={t('drill.openAccount', { code: r.code, name: r.name })}
                    onClick={(e) => {
                      // Stop the bubble, or one click would run the row handler too.
                      e.stopPropagation();
                      open();
                    }}
                  >
                    {r.name}
                  </button>
                ) : (
                  r.name
                )}
              </td>
              <td className="px-4 py-2 text-right font-mono text-slate-900">
                {formatUsd(r.amount)}
              </td>
            </tr>
          );
        })
      )}
      <tr className="bg-slate-50 font-medium">
        <td colSpan={2} className="px-4 py-2 text-right text-slate-700">
          {t(`balanceSheet.sections.${section}.total`)}
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
