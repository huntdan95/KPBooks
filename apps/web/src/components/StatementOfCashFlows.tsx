import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { reportFilename } from '../lib/report-export';
import { type CsvRow, ExportCsvButton, csvMoney } from './ReportExport';

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
  const { t } = useTranslation(['reports', 'common']);
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

  /**
   * The statement exactly as rendered. On screen the code and the account name
   * share one cell; in a spreadsheet they get a column each, so the code stays
   * sortable.
   */
  function csvRows(): CsvRow[] {
    if (!data) return [];
    const out: CsvRow[] = [[t('code'), t('common:account'), t('common:amount')]];

    const lines = (rows: ScfLine[], emptyLabel: string) => {
      if (rows.length === 0) out.push([emptyLabel]);
      for (const l of rows) out.push([l.code, l.name, csvMoney(l.amount)]);
    };

    out.push([t('cashFlows.operating')]);
    out.push(['', t('cashFlows.netIncome'), csvMoney(data.netIncome)]);
    lines(data.operatingAdjustments, t('cashFlows.noOperating'));
    out.push(['', t('cashFlows.totalOperating'), csvMoney(data.totalOperating)]);

    out.push([t('cashFlows.investing')]);
    lines(data.investing, t('cashFlows.noInvesting'));
    out.push(['', t('cashFlows.totalInvesting'), csvMoney(data.totalInvesting)]);

    out.push([t('cashFlows.financing')]);
    lines(data.financing, t('cashFlows.noFinancing'));
    out.push(['', t('cashFlows.totalFinancing'), csvMoney(data.totalFinancing)]);

    out.push(['', t('cashFlows.beginningCash'), csvMoney(data.beginningCash)]);
    out.push(['', t('cashFlows.netChange'), csvMoney(data.netChange)]);
    out.push(['', t('cashFlows.endingCash'), csvMoney(data.endingCash)]);

    // The reconciliation warning goes in the file too — a statement that does
    // not tie to the bank accounts must not look clean once it leaves the app.
    if (imbalanced) {
      out.push([]);
      out.push([
        t('cashFlows.imbalance', {
          netChange: formatUsd(data.netChange),
          endingCash: formatUsd(data.endingCash),
          beginningCash: formatUsd(data.beginningCash),
          delta: formatUsd((Number(data.endingCash) - Number(data.beginningCash)).toFixed(4)),
          difference: formatUsd(data.imbalance),
        }),
      ]);
    }
    return out;
  }

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
        <ExportCsvButton
          filename={reportFilename('statement-of-cash-flows', data?.start, data?.end)}
          meta={{
            title: t('cashFlows.reportTitle'),
            ...(data ? { start: data.start, end: data.end } : {}),
          }}
          rows={csvRows}
          disabled={query.isLoading || !data}
        />
      </div>

      <p className="text-xs text-slate-500">{t('cashFlows.method')}</p>

      {query.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : t('cashFlows.loadError')}
        </p>
      )}

      {data && (
        <>
          {imbalanced && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {t('cashFlows.imbalance', {
                netChange: formatUsd(data.netChange),
                endingCash: formatUsd(data.endingCash),
                beginningCash: formatUsd(data.beginningCash),
                delta: formatUsd(
                  (Number(data.endingCash) - Number(data.beginningCash)).toFixed(4),
                ),
                difference: formatUsd(data.imbalance),
              })}
            </div>
          )}

          <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-slate-200">
                <SectionHeader>{t('cashFlows.operating')}</SectionHeader>
                <tr>
                  <td className="px-4 py-2 text-slate-700">{t('cashFlows.netIncome')}</td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(data.netIncome)}
                  </td>
                </tr>
                {data.operatingAdjustments.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-2 text-slate-500">
                      {t('cashFlows.noOperating')}
                    </td>
                  </tr>
                ) : (
                  data.operatingAdjustments.map((l) => <Row key={l.accountId} line={l} />)
                )}
                <SubTotal label={t('cashFlows.totalOperating')} amount={data.totalOperating} />

                <SectionHeader>{t('cashFlows.investing')}</SectionHeader>
                {data.investing.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-2 text-slate-500">
                      {t('cashFlows.noInvesting')}
                    </td>
                  </tr>
                ) : (
                  data.investing.map((l) => <Row key={l.accountId} line={l} />)
                )}
                <SubTotal label={t('cashFlows.totalInvesting')} amount={data.totalInvesting} />

                <SectionHeader>{t('cashFlows.financing')}</SectionHeader>
                {data.financing.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-2 text-slate-500">
                      {t('cashFlows.noFinancing')}
                    </td>
                  </tr>
                ) : (
                  data.financing.map((l) => <Row key={l.accountId} line={l} />)
                )}
                <SubTotal label={t('cashFlows.totalFinancing')} amount={data.totalFinancing} />
              </tbody>
              <tfoot className="bg-slate-100 text-sm">
                <tr>
                  <td className="px-4 py-2 text-right text-slate-700">
                    {t('cashFlows.beginningCash')}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(data.beginningCash)}
                  </td>
                </tr>
                <tr className="font-semibold">
                  <td className="px-4 py-2 text-right text-slate-900">
                    {t('cashFlows.netChange')}
                  </td>
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
                  <td className="px-4 py-3 text-right text-slate-900">
                    {t('cashFlows.endingCash')}
                  </td>
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
