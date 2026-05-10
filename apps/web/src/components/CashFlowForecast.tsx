import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

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

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">
          Cash flow forecast
        </h2>
        <p className="text-sm text-slate-500">
          Projects cash position forward from today using current bank balances + open A/R due
          + open A/P due + active recurring templates. Tax on recurring is approximated as
          subtotal-only (line totals × quantity); the actual JE on fire will include tax.
          Forecast is an estimate — payments may land early/late, and unforecast cash events
          (one-off bills, payroll runs, deposits) aren't modeled.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="As of">
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Horizon">
          <select
            value={horizonDays}
            onChange={(e) => setHorizonDays(Number(e.target.value))}
            className={inputClass}
          >
            <option value={30}>30 days</option>
            <option value={60}>60 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>365 days</option>
          </select>
        </Field>
      </div>

      {query.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : 'Failed to load.'}
        </p>
      )}

      {data && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <Tile
              label="Starting balance"
              value={formatUsd(data.startingBalance)}
              hint={`${data.cashAccounts.length} cash account(s)`}
              tone="slate"
            />
            <Tile
              label={`Net change (${horizonDays}d)`}
              value={formatUsd(data.totals.netChange)}
              hint={`+${formatUsd(data.totals.inflows)} / -${formatUsd(data.totals.outflows)}`}
              tone={Number(data.totals.netChange) >= 0 ? 'emerald' : 'rose'}
            />
            <Tile
              label={`Projected ending`}
              value={formatUsd(data.totals.endingBalance)}
              hint={`as of ${data.weeks[data.weeks.length - 1]?.weekEnd ?? data.asOf}`}
              tone={Number(data.totals.endingBalance) >= 0 ? 'slate' : 'rose'}
            />
            <Tile
              label="Lowest projected"
              value={formatUsd(lowestBalance)}
              hint={lowestNum < 0 ? 'cash deficit ahead' : 'minimum during window'}
              tone={lowestNum < 0 ? 'rose' : 'slate'}
            />
          </div>

          {/* Tab navigation for drill-down */}
          <div className="flex gap-1 border-b border-slate-200">
            {(
              [
                ['summary', 'Weekly summary'],
                ['ar', `A/R due (${data.arDue.length})`],
                ['ap', `A/P due (${data.apDue.length})`],
                [
                  'recurring',
                  `Recurring (${data.recurringInvoices.length + data.recurringBills.length})`,
                ],
              ] as Array<[Tab, string]>
            ).map(([id, label]) => {
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
              Starting balance breakdown ({data.cashAccounts.length} account
              {data.cashAccounts.length === 1 ? '' : 's'})
            </summary>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Code</th>
                  <th className="px-4 py-2 text-left font-medium">Name</th>
                  <th className="px-4 py-2 text-left font-medium">Type</th>
                  <th className="px-4 py-2 text-right font-medium">Balance as of {data.asOf}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {data.cashAccounts.map((a) => (
                  <tr key={a.accountId}>
                    <td className="px-4 py-2 font-mono text-xs text-slate-700">{a.code}</td>
                    <td className="px-4 py-2 text-slate-900">{a.name}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{a.subtype}</td>
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
  return (
    <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Week</th>
            <th className="px-3 py-2 text-right font-medium">Opening</th>
            <th className="px-3 py-2 text-right font-medium">A/R due</th>
            <th className="px-3 py-2 text-right font-medium">Recurring in</th>
            <th className="px-3 py-2 text-right font-medium">A/P due</th>
            <th className="px-3 py-2 text-right font-medium">Recurring out</th>
            <th className="px-3 py-2 text-right font-medium">Net</th>
            <th className="px-3 py-2 text-right font-medium">Closing</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-200">
          {weeks.map((w, i) => (
            <tr key={i}>
              <td className="px-3 py-2 text-xs text-slate-700">
                <div className="font-medium text-slate-900">Week {i + 1}</div>
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
            <td className="px-3 py-3 text-slate-900">Totals</td>
            <td className="px-3 py-3 text-right text-slate-400 italic text-xs">↑ start</td>
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
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
        No open A/R due in this window.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Due</th>
            <th className="px-4 py-2 text-left font-medium">Customer</th>
            <th className="px-4 py-2 text-left font-medium">Invoice #</th>
            <th className="px-4 py-2 text-left font-medium">Invoice date</th>
            <th className="px-4 py-2 text-right font-medium">Balance due</th>
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
              Total
            </td>
            <td className="px-4 py-3 text-right font-mono text-emerald-700">{formatUsd(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ApDueTable({ rows, total }: { rows: ApDueItem[]; total: string }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
        No open A/P due in this window.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Due</th>
            <th className="px-4 py-2 text-left font-medium">Vendor</th>
            <th className="px-4 py-2 text-left font-medium">Bill #</th>
            <th className="px-4 py-2 text-left font-medium">Bill date</th>
            <th className="px-4 py-2 text-right font-medium">Balance due</th>
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
              Total
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
  const all = [
    ...invoices.map((o) => ({ ...o, kind: 'invoice' as const })),
    ...bills.map((o) => ({ ...o, kind: 'bill' as const })),
  ].sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));

  if (all.length === 0) {
    return (
      <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
        No active recurring templates fire in this window.
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
          <tr>
            <th className="px-4 py-2 text-left font-medium">Date</th>
            <th className="px-4 py-2 text-left font-medium">Type</th>
            <th className="px-4 py-2 text-left font-medium">Template</th>
            <th className="px-4 py-2 text-left font-medium">Counterparty</th>
            <th className="px-4 py-2 text-left font-medium">Frequency</th>
            <th className="px-4 py-2 text-right font-medium">Amount</th>
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
                  {o.kind === 'invoice' ? 'inflow' : 'outflow'}
                </span>
              </td>
              <td className="px-4 py-2 text-slate-900">{o.templateName}</td>
              <td className="px-4 py-2 text-xs text-slate-600">{o.counterpartyName}</td>
              <td className="px-4 py-2 text-xs text-slate-600">{o.frequency}</td>
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
              Totals
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
