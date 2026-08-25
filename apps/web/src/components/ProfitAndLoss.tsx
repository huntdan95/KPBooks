import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { reportFilename } from '../lib/report-export';
import { type AccountDrillTarget, drillButtonClass, drillRowClass } from './AccountDetail';
import { type CsvRow, type ReportMeta, ReportExportButtons, csvMoney } from './ReportExport';
import { ReportHeader } from './ReportHeader';

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
  /**
   * Cash basis only. Revenue/expense activity the cash path cannot recognise
   * because no payment sits behind it (IIF imports, hand-keyed A/R/A/P
   * entries). NOT included in the totals — surfaced so the gap is visible
   * rather than silently under-reported.
   */
  unlinkedAccrualActivity?: { revenue: string; expenses: string };
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

export function ProfitAndLoss({
  onOpenAccount,
}: {
  onOpenAccount?: ((target: AccountDrillTarget) => void) | undefined;
}) {
  const { t } = useTranslation(['reports', 'common']);
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

  /** The table exactly as rendered: sections, their totals, then net income. */
  function csvRows(): CsvRow[] {
    if (!data) return [];
    const out: CsvRow[] = [[t('code'), t('common:account'), t('common:amount')]];

    out.push([t('pnl.revenue')]);
    if (sortedRevenue.length === 0) out.push([t('pnl.noRevenue')]);
    for (const r of sortedRevenue) out.push([r.code, r.name, csvMoney(r.amount)]);
    out.push(['', t('pnl.totalRevenue'), csvMoney(data.totalRevenue)]);

    out.push([t('pnl.expenses')]);
    if (sortedExpenses.length === 0) out.push([t('pnl.noExpenses')]);
    for (const r of sortedExpenses) out.push([r.code, r.name, csvMoney(r.amount)]);
    out.push(['', t('pnl.totalExpenses'), csvMoney(data.totalExpenses)]);

    out.push(['', t(`pnl.netIncome.${data.basis}`), csvMoney(data.netIncome)]);

    // The cash-basis exclusion banner travels with the file. Whoever reconciles
    // this export against the ledger needs to know what was left out.
    if (data.unlinkedAccrualActivity && hasUnlinked(data.unlinkedAccrualActivity)) {
      out.push([]);
      out.push([t('pnl.unlinkedTitle')]);
      out.push([
        t('pnl.unlinkedBody', {
          revenue: formatUsd(data.unlinkedAccrualActivity.revenue),
          expenses: formatUsd(data.unlinkedAccrualActivity.expenses),
        }),
      ]);
    }
    return out;
  }

  // One description of the report, shared by the on-screen masthead, the CSV
  // header block and the PDF. Basis reads off data.basis — what the server
  // actually computed — not the select, which may already have moved on.
  const meta: ReportMeta = {
    title: t('pnl.reportTitle'),
    ...(data ? { start: data.start, end: data.end, basis: t(`pnl.basisBadge.${data.basis}`) } : {}),
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('common:from')}>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label={t('common:to')}>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label={t('pnl.basis')}>
          <select
            value={basis}
            onChange={(e) => setBasis(e.target.value as 'accrual' | 'cash')}
            className={inputClass}
          >
            <option value="accrual">{t('pnl.basisAccrual')}</option>
            <option value="cash">{t('pnl.basisCash')}</option>
          </select>
        </Field>
        <ReportExportButtons
          filename={reportFilename('profit-and-loss', data?.start, data?.end)}
          meta={meta}
          rows={csvRows}
          disabled={query.isLoading || !data}
        />
        <p className="pb-1 text-xs text-slate-500">{t(`pnl.basisHint.${basis}`)}</p>
      </div>

      {query.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : t('pnl.loadError')}
        </p>
      )}

      {data && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          {/* The masthead sits INSIDE the card, not up in the toolbar: the
              company, the period and the basis all have to survive a print, a
              PDF or a copy-paste of the table, where the controls that set them
              are nowhere to be seen. */}
          <ReportHeader meta={meta} />
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">{t('code')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('common:account')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('common:amount')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              <tr className="bg-slate-50">
                <td colSpan={3} className="px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-slate-500">
                  {t('pnl.revenue')}
                </td>
              </tr>
              {sortedRevenue.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-2 text-slate-500">{t('pnl.noRevenue')}</td>
                </tr>
              ) : (
                sortedRevenue.map((r) => (
                  <AccountRow
                    key={r.accountId}
                    row={r}
                    onOpen={
                      onOpenAccount
                        ? () =>
                            onOpenAccount({
                              accountId: r.accountId,
                              start: data.start,
                              end: data.end,
                              cashBasis: data.basis === 'cash',
                            })
                        : undefined
                    }
                  />
                ))
              )}
              <tr className="bg-slate-50 font-medium">
                <td colSpan={2} className="px-4 py-2 text-right text-slate-700">
                  {t('pnl.totalRevenue')}
                </td>
                <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(data.totalRevenue)}</td>
              </tr>

              <tr className="bg-slate-50">
                <td colSpan={3} className="px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-slate-500">
                  {t('pnl.expenses')}
                </td>
              </tr>
              {sortedExpenses.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-2 text-slate-500">{t('pnl.noExpenses')}</td>
                </tr>
              ) : (
                sortedExpenses.map((r) => (
                  <AccountRow
                    key={r.accountId}
                    row={r}
                    onOpen={
                      onOpenAccount
                        ? () =>
                            onOpenAccount({
                              accountId: r.accountId,
                              start: data.start,
                              end: data.end,
                              cashBasis: data.basis === 'cash',
                            })
                        : undefined
                    }
                  />
                ))
              )}
              <tr className="bg-slate-50 font-medium">
                <td colSpan={2} className="px-4 py-2 text-right text-slate-700">
                  {t('pnl.totalExpenses')}
                </td>
                <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(data.totalExpenses)}</td>
              </tr>
            </tbody>
            <tfoot className="bg-slate-100 text-sm font-semibold">
              <tr>
                <td colSpan={2} className="px-4 py-3 text-right text-slate-900">
                  {/* One whole string per basis, never a name interpolated into
                      a template: Spanish needs "base devengada" but "base de
                      efectivo", which no single template produces. */}
                  {t(`pnl.netIncome.${data.basis}`)}
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
          {data.unlinkedAccrualActivity && hasUnlinked(data.unlinkedAccrualActivity) && (
            <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium">{t('pnl.unlinkedTitle')}</p>
              <p className="mt-0.5 text-xs">
                {t('pnl.unlinkedBody', {
                  revenue: formatUsd(data.unlinkedAccrualActivity.revenue),
                  expenses: formatUsd(data.unlinkedAccrualActivity.expenses),
                })}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One account line. The whole row is a mouse target so the amount QuickZooms
 * like it does in QuickBooks, and the account name is a real <button> so the
 * same drill-down is reachable — and announced — from the keyboard.
 */
function AccountRow({ row, onOpen }: { row: PnlSection; onOpen?: (() => void) | undefined }) {
  const { t } = useTranslation('reports');
  return (
    <tr className={onOpen ? drillRowClass : undefined} onClick={onOpen}>
      <td className="px-4 py-2 font-mono text-slate-500">{row.code}</td>
      <td className="px-4 py-2 text-slate-900">
        {onOpen ? (
          <button
            type="button"
            className={drillButtonClass}
            aria-label={t('drill.openAccount', { code: row.code, name: row.name })}
            onClick={(e) => {
              // Stop the bubble, or one click would run the row handler too.
              e.stopPropagation();
              onOpen();
            }}
          >
            {row.name}
          </button>
        ) : (
          row.name
        )}
      </td>
      <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(row.amount)}</td>
    </tr>
  );
}

/** Only worth a banner when there is actually something excluded. */
function hasUnlinked(u: { revenue: string; expenses: string }): boolean {
  return Number(u.revenue) !== 0 || Number(u.expenses) !== 0;
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
