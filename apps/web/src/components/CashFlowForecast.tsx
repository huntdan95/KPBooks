import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { reportFilename } from '../lib/report-export';
import { type CsvRow, ExportCsvButton, csvMoney } from './ReportExport';

interface CashAccountRow {
  accountId: string;
  code: string;
  name: string;
  subtype: 'bank' | 'credit_card';
  balance: string;
}

interface ArDueItem {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  invoiceDate: string;
  dueDate: string;
  balanceDue: string;
}

interface ApDueItem {
  billId: string;
  billNumber: string;
  vendorId: string;
  vendorName: string;
  billDate: string;
  dueDate: string;
  balanceDue: string;
}

interface RecurringOccurrence {
  templateId: string;
  templateName: string;
  counterpartyName: string;
  frequency: 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annually';
  occurrenceDate: string;
  amount: string;
}

interface ForecastWeek {
  weekStart: string;
  weekEnd: string;
  openingBalance: string;
  arDue: string;
  recurringInflows: string;
  apDue: string;
  recurringOutflows: string;
  inflows: string;
  outflows: string;
  netChange: string;
  closingBalance: string;
}

interface CashFlowForecastResp {
  asOf: string;
  horizonDays: number;
  startingBalance: string;
  cashAccounts: CashAccountRow[];
  weeks: ForecastWeek[];
  arDue: ArDueItem[];
  apDue: ApDueItem[];
  recurringInvoices: RecurringOccurrence[];
  recurringBills: RecurringOccurrence[];
  totals: {
    arDue: string;
    apDue: string;
    recurringInflows: string;
    recurringOutflows: string;
    inflows: string;
    outflows: string;
    netChange: string;
    endingBalance: string;
  };
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);

function formatUsd(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === '') return '$0.00';
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function classForBalance(s: string): string {
  const n = Number(s);
  if (n < 0) return 'text-rose-700 font-semibold';
  if (n === 0) return 'text-slate-500';
  return 'text-slate-900 font-semibold';
}

type Tab = 'summary' | 'ar' | 'ap' | 'recurring';

export function CashFlowForecast() {
  const { t } = useTranslation(['reports', 'common']);
  const { companyId } = useCurrentCompany();
  const [asOf, setAsOf] = useState<string>(todayIso);
  const [horizonDays, setHorizonDays] = useState<number>(90);
  const [tab, setTab] = useState<Tab>('summary');

  const query = useQuery({
    queryKey: ['cash-flow-forecast', companyId, asOf, horizonDays],
    enabled: Boolean(companyId) && Boolean(asOf),
    queryFn: () =>
      api<CashFlowForecastResp>(
        `/ledger/reports/cash-flow-forecast?asOf=${asOf}&horizonDays=${horizonDays}`,
        { companyId },
      ),
  });

  const data = query.data;
  const lowestBalance = data
    ? data.weeks.reduce(
        (acc, w) => (Number(w.closingBalance) < Number(acc) ? w.closingBalance : acc),
        data.startingBalance,
      )
    : '0';
  const lowestNum = Number(lowestBalance);

  // Built once for the tab strip and reused as the exported file's "Section"
  // line, so the CSV names the same view the reader was looking at.
  const tabLabels: Record<Tab, string> = {
    summary: t('forecast.tabs.summary'),
    ar: t('forecast.tabs.ar', { count: data?.arDue.length ?? 0 }),
    ap: t('forecast.tabs.ap', { count: data?.apDue.length ?? 0 }),
    recurring: t('forecast.tabs.recurring', {
      count: (data?.recurringInvoices.length ?? 0) + (data?.recurringBills.length ?? 0),
    }),
  };

  /**
   * The tiles, the table of whichever tab is open, and the cash-account
   * breakdown — the forecast as it stands on screen. Only the open tab is
   * exported: that is the table the reader is looking at.
   */
  function csvRows(): CsvRow[] {
    if (!data) return [];
    const out: CsvRow[] = [
      [t('forecast.tiles.starting'), csvMoney(data.startingBalance)],
      [t('forecast.tiles.netChange', { days: horizonDays }), csvMoney(data.totals.netChange)],
      [t('forecast.tiles.ending'), csvMoney(data.totals.endingBalance)],
      [t('forecast.tiles.lowest'), csvMoney(lowestBalance)],
      [],
    ];

    if (tab === 'summary') {
      out.push([
        t('forecast.weekly.week'),
        t('common:from'),
        t('common:to'),
        t('forecast.weekly.opening'),
        t('forecast.weekly.arDue'),
        t('forecast.weekly.recurringIn'),
        t('forecast.weekly.apDue'),
        t('forecast.weekly.recurringOut'),
        t('forecast.weekly.net'),
        t('forecast.weekly.closing'),
      ]);
      data.weeks.forEach((w, i) => {
        // Outflow columns stay positive, as the table's own totals do — the
        // parentheses on screen are presentation, and a column of positives
        // is what sums to "total money out".
        out.push([
          t('forecast.weekly.weekN', { n: i + 1 }),
          w.weekStart,
          w.weekEnd,
          csvMoney(w.openingBalance),
          csvMoney(w.arDue),
          csvMoney(w.recurringInflows),
          csvMoney(w.apDue),
          csvMoney(w.recurringOutflows),
          csvMoney(w.netChange),
          csvMoney(w.closingBalance),
        ]);
      });
      out.push([
        t('totals'),
        '',
        '',
        t('forecast.weekly.start'),
        csvMoney(data.totals.arDue),
        csvMoney(data.totals.recurringInflows),
        csvMoney(data.totals.apDue),
        csvMoney(data.totals.recurringOutflows),
        csvMoney(data.totals.netChange),
        csvMoney(data.totals.endingBalance),
      ]);
    }

    if (tab === 'ar') {
      out.push([
        t('forecast.ar.due'),
        t('forecast.ar.customer'),
        t('forecast.ar.invoiceNumber'),
        t('forecast.ar.invoiceDate'),
        t('forecast.ar.balanceDue'),
      ]);
      if (data.arDue.length === 0) out.push([t('forecast.ar.empty')]);
      for (const r of data.arDue) {
        out.push([
          r.dueDate,
          r.customerName,
          r.invoiceNumber,
          r.invoiceDate,
          csvMoney(r.balanceDue),
        ]);
      }
      out.push([t('common:total'), '', '', '', csvMoney(data.totals.arDue)]);
    }

    if (tab === 'ap') {
      out.push([
        t('forecast.ap.due'),
        t('forecast.ap.vendor'),
        t('forecast.ap.billNumber'),
        t('forecast.ap.billDate'),
        t('forecast.ap.balanceDue'),
      ]);
      if (data.apDue.length === 0) out.push([t('forecast.ap.empty')]);
      for (const r of data.apDue) {
        out.push([r.dueDate, r.vendorName, r.billNumber, r.billDate, csvMoney(r.balanceDue)]);
      }
      out.push([t('common:total'), '', '', '', csvMoney(data.totals.apDue)]);
    }

    if (tab === 'recurring') {
      out.push([
        t('common:date'),
        t('forecast.recurring.type'),
        t('forecast.recurring.template'),
        t('forecast.recurring.counterparty'),
        t('forecast.recurring.frequency'),
        t('common:amount'),
      ]);
      const all = [
        ...data.recurringInvoices.map((o) => ({ ...o, kind: 'invoice' as const })),
        ...data.recurringBills.map((o) => ({ ...o, kind: 'bill' as const })),
      ].sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
      if (all.length === 0) out.push([t('forecast.recurring.empty')]);
      for (const o of all) {
        out.push([
          o.occurrenceDate,
          o.kind === 'invoice'
            ? t('forecast.recurring.inflow')
            : t('forecast.recurring.outflow'),
          o.templateName,
          o.counterpartyName,
          t(`frequencies.${o.frequency}`),
          csvMoney(o.amount),
        ]);
      }
      out.push([
        t('totals'),
        t('forecast.recurring.inflow'),
        '',
        '',
        '',
        csvMoney(data.totals.recurringInflows),
      ]);
      out.push([
        t('totals'),
        t('forecast.recurring.outflow'),
        '',
        '',
        '',
        csvMoney(data.totals.recurringOutflows),
      ]);
    }

    out.push([]);
    out.push([
      t('code'),
      t('common:name'),
      t('forecast.breakdownColumns.type'),
      t('forecast.breakdownColumns.balanceAsOf', { date: data.asOf }),
    ]);
    for (const a of data.cashAccounts) {
      out.push([a.code, a.name, t(`subtypes.${a.subtype}`), csvMoney(a.balance)]);
    }
    return out;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">
          {t('forecast.title')}
        </h2>
        <p className="text-sm text-slate-500">{t('forecast.description')}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('common:asOf')}>
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label={t('forecast.horizon')}>
          <select
            value={horizonDays}
            onChange={(e) => setHorizonDays(Number(e.target.value))}
            className={inputClass}
          >
            {[30, 60, 90, 180, 365].map((days) => (
              <option key={days} value={days}>
                {t('forecast.horizonOption', { days })}
              </option>
            ))}
          </select>
        </Field>
        <ExportCsvButton
          filename={reportFilename('cash-flow-forecast', tab, data?.asOf ?? asOf)}
          meta={{
            title: t('forecast.title'),
            asOf: data?.asOf ?? asOf,
            extra: [
              [t('forecast.horizon'), t('forecast.horizonOption', { days: horizonDays })],
              [t('export.meta.section'), tabLabels[tab]],
            ],
          }}
          rows={csvRows}
          disabled={query.isLoading || !data}
        />
      </div>

      {query.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : t('forecast.loadError')}
        </p>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Tile
              label={t('forecast.tiles.starting')}
              value={formatUsd(data.startingBalance)}
              hint={t('forecast.tiles.startingHint', { count: data.cashAccounts.length })}
              tone="slate"
            />
            <Tile
              label={t('forecast.tiles.netChange', { days: horizonDays })}
              value={formatUsd(data.totals.netChange)}
              hint={t('forecast.tiles.netChangeHint', {
                inflows: formatUsd(data.totals.inflows),
                outflows: formatUsd(data.totals.outflows),
              })}
              tone={Number(data.totals.netChange) >= 0 ? 'emerald' : 'rose'}
            />
            <Tile
              label={t('forecast.tiles.ending')}
              value={formatUsd(data.totals.endingBalance)}
              hint={t('forecast.tiles.endingHint', {
                date: data.weeks[data.weeks.length - 1]?.weekEnd ?? data.asOf,
              })}
              tone={Number(data.totals.endingBalance) >= 0 ? 'slate' : 'rose'}
            />
            <Tile
              label={t('forecast.tiles.lowest')}
              value={formatUsd(lowestBalance)}
              hint={
                lowestNum < 0
                  ? t('forecast.tiles.lowestDeficit')
                  : t('forecast.tiles.lowestMin')
              }
              tone={lowestNum < 0 ? 'rose' : 'slate'}
            />
          </div>

          {/* Tab navigation for drill-down */}
          <div className="flex gap-1 border-b border-slate-200">
            {(['summary', 'ar', 'ap', 'recurring'] as Tab[]).map((id) => {
              const label = tabLabels[id];
              const active = tab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={
                    'border-b-2 px-3 py-2 text-sm transition-colors -mb-px ' +
                    (active
                      ? 'border-slate-900 font-medium text-slate-900'
                      : 'border-transparent text-slate-500 hover:text-slate-800')
                  }
                >
                  {label}
                </button>
              );
            })}
          </div>

          {tab === 'summary' && <WeeklyTable weeks={data.weeks} totals={data.totals} />}
          {tab === 'ar' && <ArDueTable rows={data.arDue} total={data.totals.arDue} />}
          {tab === 'ap' && <ApDueTable rows={data.apDue} total={data.totals.apDue} />}
          {tab === 'recurring' && (
            <RecurringTable
              invoices={data.recurringInvoices}
              bills={data.recurringBills}
              totalIn={data.totals.recurringInflows}
              totalOut={data.totals.recurringOutflows}
            />
          )}

          {/* Cash account breakdown */}
          <details className="rounded-md border border-slate-200 bg-white">
            <summary className="cursor-pointer border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700">
              {t('forecast.breakdown', { count: data.cashAccounts.length })}
            </summary>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">{t('code')}</th>
                  <th className="px-4 py-2 text-left font-medium">{t('common:name')}</th>
                  <th className="px-4 py-2 text-left font-medium">
                    {t('forecast.breakdownColumns.type')}
                  </th>
                  <th className="px-4 py-2 text-right font-medium">
                    {t('forecast.breakdownColumns.balanceAsOf', { date: data.asOf })}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {data.cashAccounts.map((a) => (
                  <tr key={a.accountId}>
                    <td className="px-4 py-2 font-mono text-xs text-slate-700">{a.code}</td>
                    <td className="px-4 py-2 text-slate-900">{a.name}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">
                      {t(`subtypes.${a.subtype}`)}
                    </td>
                    <td className={'px-4 py-2 text-right font-mono ' + classForBalance(a.balance)}>
                      {formatUsd(a.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </div>
  );
}

function WeeklyTable({
  weeks,
  totals,
}: {
  weeks: ForecastWeek[];
  totals: CashFlowForecastResp['totals'];
}) {
  const { t } = useTranslation('reports');
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left font-medium">{t('forecast.weekly.week')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('forecast.weekly.opening')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('forecast.weekly.arDue')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('forecast.weekly.recurringIn')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('forecast.weekly.apDue')}</th>
            <th className="px-3 py-2 text-right font-medium">
              {t('forecast.weekly.recurringOut')}
            </th>
            <th className="px-3 py-2 text-right font-medium">{t('forecast.weekly.net')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('forecast.weekly.closing')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {weeks.map((w, i) => (
            <tr key={i}>
              <td className="px-3 py-2 text-xs text-slate-700">
                <div className="font-medium text-slate-900">
                  {t('forecast.weekly.weekN', { n: i + 1 })}
                </div>
                <div className="font-mono text-[10px] text-slate-500">
                  {w.weekStart} → {w.weekEnd}
                </div>
              </td>
              <td className="px-3 py-2 text-right font-mono text-slate-700">
                {formatUsd(w.openingBalance)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-emerald-700">
                {Number(w.arDue) > 0 ? formatUsd(w.arDue) : <span className="text-slate-300">—</span>}
              </td>
              <td className="px-3 py-2 text-right font-mono text-emerald-700">
                {Number(w.recurringInflows) > 0
                  ? formatUsd(w.recurringInflows)
                  : <span className="text-slate-300">—</span>}
              </td>
              <td className="px-3 py-2 text-right font-mono text-rose-700">
                {Number(w.apDue) > 0 ? `(${formatUsd(w.apDue)})` : <span className="text-slate-300">—</span>}
              </td>
              <td className="px-3 py-2 text-right font-mono text-rose-700">
                {Number(w.recurringOutflows) > 0
                  ? `(${formatUsd(w.recurringOutflows)})`
                  : <span className="text-slate-300">—</span>}
              </td>
              <td className={'px-3 py-2 text-right font-mono ' + classForBalance(w.netChange)}>
                {formatUsd(w.netChange)}
              </td>
              <td className={'px-3 py-2 text-right font-mono ' + classForBalance(w.closingBalance)}>
                {formatUsd(w.closingBalance)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-slate-100 text-sm font-semibold">
          <tr>
            <td className="px-3 py-3 text-slate-900">{t('totals')}</td>
            <td className="px-3 py-3 text-right text-slate-400 italic text-xs">
              {t('forecast.weekly.start')}
            </td>
            <td className="px-3 py-3 text-right font-mono text-emerald-700">
              {formatUsd(totals.arDue)}
            </td>
            <td className="px-3 py-3 text-right font-mono text-emerald-700">
              {formatUsd(totals.recurringInflows)}
            </td>
            <td className="px-3 py-3 text-right font-mono text-rose-700">
              ({formatUsd(totals.apDue)})
            </td>
            <td className="px-3 py-3 text-right font-mono text-rose-700">
              ({formatUsd(totals.recurringOutflows)})
            </td>
            <td className={'px-3 py-3 text-right font-mono ' + classForBalance(totals.netChange)}>
              {formatUsd(totals.netChange)}
            </td>
            <td className={'px-3 py-3 text-right font-mono ' + classForBalance(totals.endingBalance)}>
              {formatUsd(totals.endingBalance)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ArDueTable({ rows, total }: { rows: ArDueItem[]; total: string }) {
  const { t } = useTranslation(['reports', 'common']);
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
        {t('forecast.ar.empty')}
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-4 py-2 text-left font-medium">{t('forecast.ar.due')}</th>
            <th className="px-4 py-2 text-left font-medium">{t('forecast.ar.customer')}</th>
            <th className="px-4 py-2 text-left font-medium">{t('forecast.ar.invoiceNumber')}</th>
            <th className="px-4 py-2 text-left font-medium">{t('forecast.ar.invoiceDate')}</th>
            <th className="px-4 py-2 text-right font-medium">{t('forecast.ar.balanceDue')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {rows.map((r) => (
            <tr key={r.invoiceId}>
              <td className="px-4 py-2 font-mono text-xs text-slate-700">{r.dueDate}</td>
              <td className="px-4 py-2 text-slate-900">{r.customerName}</td>
              <td className="px-4 py-2 font-mono text-xs text-slate-600">{r.invoiceNumber}</td>
              <td className="px-4 py-2 font-mono text-xs text-slate-500">{r.invoiceDate}</td>
              <td className="px-4 py-2 text-right font-mono text-slate-900">
                {formatUsd(r.balanceDue)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-slate-100 text-sm font-semibold">
          <tr>
            <td colSpan={4} className="px-4 py-3 text-right text-slate-900">
              {t('common:total')}
            </td>
            <td className="px-4 py-3 text-right font-mono text-emerald-700">{formatUsd(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ApDueTable({ rows, total }: { rows: ApDueItem[]; total: string }) {
  const { t } = useTranslation(['reports', 'common']);
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
        {t('forecast.ap.empty')}
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-4 py-2 text-left font-medium">{t('forecast.ap.due')}</th>
            <th className="px-4 py-2 text-left font-medium">{t('forecast.ap.vendor')}</th>
            <th className="px-4 py-2 text-left font-medium">{t('forecast.ap.billNumber')}</th>
            <th className="px-4 py-2 text-left font-medium">{t('forecast.ap.billDate')}</th>
            <th className="px-4 py-2 text-right font-medium">{t('forecast.ap.balanceDue')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {rows.map((r) => (
            <tr key={r.billId}>
              <td className="px-4 py-2 font-mono text-xs text-slate-700">{r.dueDate}</td>
              <td className="px-4 py-2 text-slate-900">{r.vendorName}</td>
              <td className="px-4 py-2 font-mono text-xs text-slate-600">{r.billNumber}</td>
              <td className="px-4 py-2 font-mono text-xs text-slate-500">{r.billDate}</td>
              <td className="px-4 py-2 text-right font-mono text-slate-900">
                {formatUsd(r.balanceDue)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-slate-100 text-sm font-semibold">
          <tr>
            <td colSpan={4} className="px-4 py-3 text-right text-slate-900">
              {t('common:total')}
            </td>
            <td className="px-4 py-3 text-right font-mono text-rose-700">{formatUsd(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function RecurringTable({
  invoices,
  bills,
  totalIn,
  totalOut,
}: {
  invoices: RecurringOccurrence[];
  bills: RecurringOccurrence[];
  totalIn: string;
  totalOut: string;
}) {
  const { t } = useTranslation(['reports', 'common']);
  const all = [
    ...invoices.map((o) => ({ ...o, kind: 'invoice' as const })),
    ...bills.map((o) => ({ ...o, kind: 'bill' as const })),
  ].sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));

  if (all.length === 0) {
    return (
      <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
        {t('forecast.recurring.empty')}
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-4 py-2 text-left font-medium">{t('common:date')}</th>
            <th className="px-4 py-2 text-left font-medium">{t('forecast.recurring.type')}</th>
            <th className="px-4 py-2 text-left font-medium">{t('forecast.recurring.template')}</th>
            <th className="px-4 py-2 text-left font-medium">
              {t('forecast.recurring.counterparty')}
            </th>
            <th className="px-4 py-2 text-left font-medium">{t('forecast.recurring.frequency')}</th>
            <th className="px-4 py-2 text-right font-medium">{t('common:amount')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {all.map((o, i) => (
            <tr key={`${o.templateId}-${i}`}>
              <td className="px-4 py-2 font-mono text-xs text-slate-700">{o.occurrenceDate}</td>
              <td className="px-4 py-2">
                <span
                  className={
                    'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
                    (o.kind === 'invoice'
                      ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                      : 'bg-rose-50 text-rose-700 ring-rose-600/20')
                  }
                >
                  {o.kind === 'invoice'
                    ? t('forecast.recurring.inflow')
                    : t('forecast.recurring.outflow')}
                </span>
              </td>
              <td className="px-4 py-2 text-slate-900">{o.templateName}</td>
              <td className="px-4 py-2 text-xs text-slate-600">{o.counterpartyName}</td>
              <td className="px-4 py-2 text-xs text-slate-600">
                {t(`frequencies.${o.frequency}`)}
              </td>
              <td
                className={
                  'px-4 py-2 text-right font-mono ' +
                  (o.kind === 'invoice' ? 'text-emerald-700' : 'text-rose-700')
                }
              >
                {o.kind === 'invoice' ? formatUsd(o.amount) : `(${formatUsd(o.amount)})`}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-slate-100 text-sm font-semibold">
          <tr>
            <td colSpan={5} className="px-4 py-3 text-right text-slate-900">
              {t('totals')}
            </td>
            <td className="px-4 py-3 text-right text-xs">
              <span className="text-emerald-700">+{formatUsd(totalIn)}</span>{' '}
              <span className="text-rose-700">/ -{formatUsd(totalOut)}</span>
            </td>
          </tr>
        </tfoot>
      </table>
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
