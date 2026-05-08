import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface ScfLine {
  accountId: string;
  code: string;
  name: string;
  amount: string;
}

interface ScfResponse {
  start: string;
  end: string;
  netIncome: string;
  operatingAdjustments: ScfLine[];
  totalOperating: string;
  investing: ScfLine[];
  totalInvesting: string;
  financing: ScfLine[];
  totalFinancing: string;
  netChange: string;
  beginningCash: string;
  endingCash: string;
  imbalance: string;
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const firstOfYear = () => `${new Date().getUTCFullYear()}-01-01`;

function formatUsd(s: string): string {
  if (!s) return '$0.00';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

export function StatementOfCashFlows() {
  const { companyId } = useCurrentCompany();
  const [start, setStart] = useState<string>(firstOfYear);
  const [end, setEnd] = useState<string>(todayIso);

  const query = useQuery({
    queryKey: ['scf', companyId, start, end],
    enabled: Boolean(companyId) && Boolean(start) && Boolean(end),
    queryFn: () =>
      api<ScfResponse>(`/ledger/reports/statement-of-cash-flows?start=${start}&end=${end}`, {
        companyId,
      }),
  });

  const data = query.data;
  const imbalanced = data && Number(data.imbalance) !== 0;

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
      </div>

      <p className="text-xs text-slate-500">
        Indirect method. Starts with net income for the period, then walks the change in every
        non-cash balance sheet account (sourced from posted journal entries) to reconcile to the
        actual change in cash. Bucketed by account subtype: working-capital changes flow to
        operating; fixed/other assets to investing; long-term liabilities and equity to financing.
      </p>

      {query.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : 'Failed to load statement.'}
        </p>
      )}

      {data && (
        <>
          {imbalanced && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              Cash flow ({formatUsd(data.netChange)}) does not match the change in bank-account
              balances ({formatUsd(data.endingCash)} − {formatUsd(data.beginningCash)} ={' '}
              {formatUsd(
                (Number(data.endingCash) - Number(data.beginningCash)).toFixed(4),
              )}
              ). Difference: {formatUsd(data.imbalance)}. This usually indicates direct journal
              entries to retained earnings or other equity accounts that bypass the indirect-method
              assumptions.
            </div>
          )}

          <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-200">
                <SectionHeader>Operating activities</SectionHeader>
                <tr>
                  <td className="px-4 py-2 text-slate-700">Net income</td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(data.netIncome)}
                  </td>
                </tr>
                {data.operatingAdjustments.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-2 text-slate-500">
                      No working-capital adjustments.
                    </td>
                  </tr>
                ) : (
                  data.operatingAdjustments.map((l) => <Row key={l.accountId} line={l} />)
                )}
                <SubTotal label="Net cash from operating activities" amount={data.totalOperating} />

                <SectionHeader>Investing activities</SectionHeader>
                {data.investing.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-2 text-slate-500">
                      No investing activity.
                    </td>
                  </tr>
                ) : (
                  data.investing.map((l) => <Row key={l.accountId} line={l} />)
                )}
                <SubTotal label="Net cash from investing activities" amount={data.totalInvesting} />

                <SectionHeader>Financing activities</SectionHeader>
                {data.financing.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-2 text-slate-500">
                      No financing activity.
                    </td>
                  </tr>
                ) : (
                  data.financing.map((l) => <Row key={l.accountId} line={l} />)
                )}
                <SubTotal label="Net cash from financing activities" amount={data.totalFinancing} />
              </tbody>
              <tfoot className="bg-slate-100 text-sm">
                <tr>
                  <td className="px-4 py-2 text-right text-slate-700">Cash at start of period</td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(data.beginningCash)}
                  </td>
                </tr>
                <tr className="font-semibold">
                  <td className="px-4 py-2 text-right text-slate-900">Net change in cash</td>
                  <td
                    className={
                      'px-4 py-2 text-right font-mono ' +
                      (Number(data.netChange) >= 0 ? 'text-emerald-700' : 'text-rose-700')
                    }
                  >
                    {formatUsd(data.netChange)}
                  </td>
                </tr>
                <tr className="font-semibold">
                  <td className="px-4 py-3 text-right text-slate-900">Cash at end of period</td>
                  <td className="px-4 py-3 text-right font-mono text-slate-900">
                    {formatUsd(data.endingCash)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ line }: { line: ScfLine }) {
  const negative = Number(line.amount) < 0;
  return (
    <tr>
      <td className="px-4 py-2 text-slate-700">
        <span className="font-mono text-xs text-slate-400 mr-2">{line.code}</span>
        {line.name}
      </td>
      <td
        className={
          'px-4 py-2 text-right font-mono ' + (negative ? 'text-rose-700' : 'text-slate-900')
        }
      >
        {formatUsd(line.amount)}
      </td>
    </tr>
  );
}

function SubTotal({ label, amount }: { label: string; amount: string }) {
  return (
    <tr className="bg-slate-50 font-medium">
      <td className="px-4 py-2 text-right text-slate-700">{label}</td>
      <td
        className={
          'px-4 py-2 text-right font-mono ' +
          (Number(amount) >= 0 ? 'text-slate-900' : 'text-rose-700')
        }
      >
        {formatUsd(amount)}
      </td>
    </tr>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <tr className="bg-slate-50">
      <td
        colSpan={2}
        className="px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-slate-500"
      >
        {children}
      </td>
    </tr>
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
