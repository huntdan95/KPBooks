import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { reportFilename } from '../lib/report-export';
import { type AccountDrillTarget, drillButtonClass, drillRowClass } from './AccountDetail';
import { type CsvRow, ExportCsvButton, csvMoney, csvSide } from './ReportExport';

interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subtype: string;
  debit: string;
  credit: string;
  balance: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Trial balance figures are cumulative, so there is no range to hand the
 * drill-down. Open it on the year to date and let the account detail carry the
 * prior years in as its opening balance — nothing is lost, and the detail view
 * has its own From/To if a wider window is wanted.
 */
const yearStartOf = (asOf: string) => `${asOf.slice(0, 4)}-01-01`;

function addCents(a: string, b: string): string {
  const toMicros = (s: string) => {
    if (!s) return 0n;
    const [whole, frac = ''] = s.replace(/,/g, '').split('.');
    const padded = (frac + '0000').slice(0, 4);
    return BigInt(whole || '0') * 10000n + BigInt(padded || '0');
  };
  const sum = toMicros(a) + toMicros(b);
  const negative = sum < 0n;
  const abs = negative ? -sum : sum;
  const whole = abs / 10000n;
  const frac = abs % 10000n;
  return `${negative ? '-' : ''}${whole}.${String(frac).padStart(4, '0')}`;
}

function formatUsd(s: string): string {
  if (!s) return '';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

const ORDER: TrialBalanceRow['type'][] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

export function TrialBalance({
  onOpenAccount,
}: {
  onOpenAccount?: ((target: AccountDrillTarget) => void) | undefined;
}) {
  const { t } = useTranslation(['reports', 'common']);
  const { companyId } = useCurrentCompany();
  const [asOf, setAsOf] = useState<string>(today);

  const query = useQuery({
    queryKey: ['trial-balance', companyId, asOf],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ asOf: string; rows: TrialBalanceRow[] }>(
        `/ledger/reports/trial-balance?asOf=${asOf}`,
        { companyId },
      ),
  });

  const rows = useMemo(() => {
    const all = query.data?.rows ?? [];
    return [...all].sort((a, b) => a.code.localeCompare(b.code));
  }, [query.data]);

  const totals = useMemo(() => {
    let debit = '0';
    let credit = '0';
    for (const r of rows) {
      debit = addCents(debit, r.debit);
      credit = addCents(credit, r.credit);
    }
    return { debit, credit };
  }, [rows]);

  const balanced = totals.debit === totals.credit;

  const grouped = useMemo(() => {
    const map: Partial<Record<TrialBalanceRow['type'], TrialBalanceRow[]>> = {};
    for (const r of rows) {
      (map[r.type] ??= []).push(r);
    }
    return map;
  }, [rows]);

  /** The table exactly as rendered: section headers, rows, totals. */
  function csvRows(): CsvRow[] {
    const out: CsvRow[] = [
      [t('code'), t('common:account'), t('common:debit'), t('common:credit'), t('common:balance')],
    ];
    for (const type of ORDER) {
      const group = grouped[type];
      if (!group?.length) continue;
      out.push([t(`accountTypes.${type}`)]);
      for (const r of group) {
        out.push([r.code, r.name, csvSide(r.debit), csvSide(r.credit), csvMoney(r.balance)]);
      }
    }
    out.push([
      '',
      t('totals'),
      csvMoney(totals.debit),
      csvMoney(totals.credit),
      balanced ? t('trialBalance.balanced') : t('trialBalance.unbalanced'),
    ]);
    return out;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">
          {t('trialBalance.title')}
        </h2>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            {t('common:asOf')}
            <input
              type="date"
              value={asOf}
              onChange={(e) => setAsOf(e.target.value)}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-slate-900 focus:outline-none"
            />
          </label>
          <ExportCsvButton
            filename={reportFilename('trial-balance', query.data?.asOf ?? asOf)}
            meta={{ title: t('trialBalance.title'), asOf: query.data?.asOf ?? asOf }}
            rows={csvRows}
            disabled={query.isLoading || rows.length === 0}
          />
        </div>
      </div>

      {query.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : t('trialBalance.loadError')}
        </p>
      )}

      {query.data && rows.length === 0 && (
        <p className="text-sm text-slate-500">{t('trialBalance.empty', { asOf })}</p>
      )}

      {rows.length > 0 && (
        <div className="max-h-[70vh] overflow-auto rounded-md border border-slate-200 bg-white">
          <table className="kpb-sticky-thead w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">{t('code')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('common:account')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('common:debit')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('common:credit')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('common:balance')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {ORDER.flatMap((type) => {
                const group = grouped[type];
                if (!group?.length) return [];
                return [
                  <tr key={`hdr-${type}`} className="bg-slate-50">
                    <td colSpan={5} className="px-4 py-1.5 text-xs font-medium uppercase tracking-wider text-slate-500">
                      {t(`accountTypes.${type}`)}
                    </td>
                  </tr>,
                  ...group.map((r) => {
                    // The whole row is a mouse target so the amounts QuickZoom
                    // like they do in QuickBooks; the account name is a real
                    // <button> so the same drill-down is reachable — and
                    // announced — from the keyboard.
                    const open = onOpenAccount
                      ? () =>
                          onOpenAccount({
                            accountId: r.accountId,
                            start: yearStartOf(asOf),
                            end: asOf,
                          })
                      : undefined;
                    return (
                      <tr
                        key={r.accountId}
                        className={open ? drillRowClass : undefined}
                        onClick={open}
                      >
                        <td className="px-4 py-2 font-mono text-slate-500">{r.code}</td>
                        <td className="px-4 py-2 text-slate-900">
                          {open ? (
                            <button
                              type="button"
                              className={drillButtonClass}
                              aria-label={t('drill.openAccount', { code: r.code, name: r.name })}
                              onClick={(e) => {
                                // Stop the bubble, or one click would run the
                                // row handler too.
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
                          {Number(r.debit) > 0 ? formatUsd(r.debit) : ''}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-slate-900">
                          {Number(r.credit) > 0 ? formatUsd(r.credit) : ''}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-slate-700">
                          {formatUsd(r.balance)}
                        </td>
                      </tr>
                    );
                  }),
                ];
              })}
            </tbody>
            <tfoot className="bg-slate-50 text-sm font-medium">
              <tr>
                <td colSpan={2} className="px-4 py-2 text-right text-slate-600">
                  {t('totals')}
                </td>
                <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(totals.debit)}</td>
                <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(totals.credit)}</td>
                <td className="px-4 py-2 text-right">
                  <span className={balanced ? 'text-emerald-600' : 'text-rose-600'}>
                    {balanced ? t('trialBalance.balanced') : t('trialBalance.unbalanced')}
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
