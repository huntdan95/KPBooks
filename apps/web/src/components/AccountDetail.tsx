/**
 * The drill-down pair.
 *
 * `AccountDetail` is the QuickZoom target: click an account on the P&L, the
 * balance sheet or the trial balance and land here, on every posting that
 * account took over the originating report's date range, with the opening
 * balance carried in and a running balance down the page.
 *
 * `GeneralLedger` is the same rows for the whole chart of accounts, grouped by
 * account. It lives in this file rather than its own because it renders the
 * identical row shape and shares the formatting helpers — the same reason
 * CustomerDetail and VendorDetail share CounterpartyDetail.tsx.
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { reportFilename } from '../lib/report-export';
import { type CsvRow, type ReportMeta, ReportExportButtons, csvMoney, csvSide } from './ReportExport';
import { ReportHeader } from './ReportHeader';

type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
type NormalBalance = 'debit' | 'credit';

type LedgerDocumentType =
  | 'invoice'
  | 'bill'
  | 'payment'
  | 'journal'
  | 'bank_transaction'
  | 'reconciliation'
  | 'payroll'
  | 'import';

interface LedgerDetailRow {
  lineId: string;
  entryId: string;
  entryDate: string;
  documentType: LedgerDocumentType;
  documentNumber: string | null;
  isReversal: boolean;
  memo: string | null;
  counterpartyName: string | null;
  debit: string;
  credit: string;
  runningBalance: string;
}

interface AccountSummary {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  isActive: boolean;
  normalBalance: NormalBalance;
}

interface AccountDetailResponse {
  start: string;
  end: string;
  account: AccountSummary;
  openingBalance: string;
  pageOpeningBalance: string;
  rows: LedgerDetailRow[];
  totalDebit: string;
  totalCredit: string;
  closingBalance: string;
  rowCount: number;
  limit: number;
  offset: number;
  returnedRows: number;
  truncated: boolean;
  hasMore: boolean;
}

interface LedgerAccountGroup extends AccountSummary {
  openingBalance: string;
  totalDebit: string;
  totalCredit: string;
  closingBalance: string;
  rowCount: number;
  rows: LedgerDetailRow[];
  truncated: boolean;
}

interface GeneralLedgerResponse {
  start: string;
  end: string;
  accountId: string | null;
  accounts: LedgerAccountGroup[];
  rowCap: number;
  totalRowCount: number;
  returnedRows: number;
  truncated: boolean;
  totals: { totalDebit: string; totalCredit: string; accountCount: number };
}

interface Account {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}

/** Where a drill-down lands: one account, over the originating report's range. */
export interface AccountDrillTarget {
  accountId: string;
  start: string;
  end: string;
  /**
   * Set when the click came from a CASH-basis P&L. The ledger is always
   * accrual, so these rows will not add up to the figure that was clicked —
   * we say so on screen rather than let the preparer chase the difference.
   */
  cashBasis?: boolean;
}

/** UI page size. The endpoint's own default is 500; 100 reads better on screen. */
const PAGE_SIZE = 100;

/**
 * What Export CSV asks for. Matches ACCOUNT_DETAIL_MAX_PAGE_SIZE on the
 * endpoint, so a whole account comes back in one request instead of the CPA
 * paging and exporting fourteen files by hand.
 */
const EXPORT_PAGE_SIZE = 5000;

/**
 * Ledger rows committed to the DOM in one pass by the general ledger. Each is
 * seven <td>s, so the server's 5,000-row cap is ~50,000 nodes in a single React
 * commit and the tab visibly locks up while it lands. Everything is fetched —
 * this only staggers what is painted, and Export CSV is never capped.
 */
const SCREEN_ROW_CAP = 750;

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

/** A ledger page shows one side per row — blank beats $0.00 in the empty column. */
function formatSide(s: string): string {
  return Number(s) > 0 ? formatUsd(s) : '';
}

export function AccountDetail({
  target,
  backLabel,
  onBack,
}: {
  target: AccountDrillTarget;
  /**
   * The Back button's whole label, already translated. Not just the report
   * name: Spanish needs an article that is gendered and contracts with `a`, so
   * the sentence cannot be assembled here. See BACK_LABEL_KEY in Reports.tsx.
   */
  backLabel: string;
  onBack: () => void;
}) {
  const { t } = useTranslation(['reports', 'common']);
  const { companyId } = useCurrentCompany();
  const [start, setStart] = useState<string>(target.start);
  const [end, setEnd] = useState<string>(target.end);
  const [offset, setOffset] = useState(0);

  const query = useQuery({
    queryKey: ['account-detail', companyId, target.accountId, start, end, offset],
    enabled: Boolean(companyId) && Boolean(start) && Boolean(end),
    // Hold the current page on screen while the next one loads, so paging
    // doesn't blank the table out from under the reader.
    placeholderData: keepPreviousData,
    queryFn: () =>
      api<AccountDetailResponse>(
        `/ledger/reports/account-detail?accountId=${target.accountId}` +
          `&start=${start}&end=${end}&limit=${PAGE_SIZE}&offset=${offset}`,
        { companyId },
      ),
  });

  const data = query.data;
  const notFound = query.error instanceof ApiError && query.error.status === 404;
  const account = data?.account;

  /**
   * The four summary tiles, then EVERY ledger line in the range — not the page
   * on screen. The footer carries whole-range totals (the endpoint computes
   * them independently of the page), so a file holding one page underneath them
   * would not cross-foot: its own debit, credit and running-balance columns
   * would contradict its own footer. The endpoint serves EXPORT_PAGE_SIZE rows
   * per request, so the export refetches at that size.
   */
  async function csvRows(): Promise<CsvRow[]> {
    if (!data) return [];
    let full = data;
    if (data.truncated && companyId) {
      try {
        full = await api<AccountDetailResponse>(
          `/ledger/reports/account-detail?accountId=${target.accountId}` +
            `&start=${start}&end=${end}&limit=${EXPORT_PAGE_SIZE}&offset=0`,
          { companyId },
        );
      } catch {
        // Fall back to what is already on screen rather than exporting
        // nothing. The row-count line and fullRangeNote below both read off
        // `full`, so the file still says exactly which rows it holds.
        full = data;
      }
    }

    const out: CsvRow[] = [
      [
        t('export.meta.rows'),
        t('accountDetail.showing', {
          first: full.offset + 1,
          last: full.offset + full.returnedRows,
          total: full.rowCount,
        }),
      ],
      [],
      [t('accountDetail.openingBalance'), csvMoney(full.openingBalance)],
      [t('accountDetail.periodDebits'), csvMoney(full.totalDebit)],
      [t('accountDetail.periodCredits'), csvMoney(full.totalCredit)],
      [t('accountDetail.closingBalance'), csvMoney(full.closingBalance)],
      [],
      [
        t('common:date'),
        t('accountDetail.columns.sourceDoc'),
        t('common:memo'),
        t('accountDetail.columns.counterparty'),
        t('common:debit'),
        t('common:credit'),
        t('accountDetail.columns.runningBalance'),
      ],
      [
        full.offset > 0 ? t('accountDetail.broughtForward') : t('accountDetail.openingBalance'),
        '',
        '',
        '',
        '',
        '',
        csvMoney(full.pageOpeningBalance),
      ],
    ];
    for (const r of full.rows) out.push(detailCsvRow(r, t));
    out.push([
      t('accountDetail.periodTotals'),
      '',
      '',
      '',
      csvMoney(full.totalDebit),
      csvMoney(full.totalCredit),
      csvMoney(full.closingBalance),
    ]);
    if (full.truncated) {
      out.push([]);
      out.push([t('accountDetail.fullRangeNote')]);
    }
    return out;
  }

  // The row count is NOT in here: this is built before the export refetches
  // the full range, so only csvRows() knows how many rows the file ended up
  // with. It writes that line itself, as the first row of the body.
  const meta: ReportMeta = {
    title: t('accountDetail.title'),
    ...(data ? { start: data.start, end: data.end } : {}),
    extra: [
      [t('common:account'), account?.code ?? '', account?.name ?? ''],
      ...(target.cashBasis ? [[t('accountDetail.accrualNotice')] as CsvRow] : []),
    ],
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          {backLabel}
        </button>
        <span className="text-xs uppercase tracking-wider text-slate-500">
          {t('accountDetail.title')}
        </span>
      </div>

      {target.cashBasis && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {t('accountDetail.accrualNotice')}
        </p>
      )}

      <div className="rounded-md border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="font-mono text-xs text-slate-500">{account?.code ?? '—'}</p>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">
              {account?.name ?? t('accountDetail.title')}
              {account && !account.isActive && (
                <span className="ml-2 align-middle text-sm font-normal text-slate-500">
                  {t('accounts.inactiveTag')}
                </span>
              )}
            </h2>
            {account && (
              <p className="text-xs text-slate-500">
                {t(`accountTypes.${account.type}`)} · {t(`subtypes.${account.subtype}`)}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('common:from')}>
              <input
                type="date"
                value={start}
                onChange={(e) => {
                  setStart(e.target.value);
                  setOffset(0);
                }}
                className={inputClass}
              />
            </Field>
            <Field label={t('common:to')}>
              <input
                type="date"
                value={end}
                onChange={(e) => {
                  setEnd(e.target.value);
                  setOffset(0);
                }}
                className={inputClass}
              />
            </Field>
            <ReportExportButtons
              filename={reportFilename('account-detail', account?.code, data?.start, data?.end)}
              meta={meta}
              rows={csvRows}
              disabled={query.isLoading || !data || data.rowCount === 0}
            />
          </div>
        </div>

        {data && (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Tile label={t('accountDetail.openingBalance')} value={formatUsd(data.openingBalance)} />
            <Tile label={t('accountDetail.periodDebits')} value={formatUsd(data.totalDebit)} />
            <Tile label={t('accountDetail.periodCredits')} value={formatUsd(data.totalCredit)} />
            <Tile
              label={t('accountDetail.closingBalance')}
              value={formatUsd(data.closingBalance)}
              emphasis
            />
          </div>
        )}
      </div>

      {query.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {notFound && <p className="text-sm text-rose-600">{t('accountDetail.notFound')}</p>}
      {query.isError && !notFound && (
        // Never the thrown message: ApiError's is the hardcoded, untranslated
        // `API 500`, which means nothing to a bookkeeper reading Spanish. The
        // status rides along in the title so a support call still has it.
        <p
          className="text-sm text-rose-600"
          title={query.error instanceof Error ? query.error.message : undefined}
        >
          {t('accountDetail.loadError')}
        </p>
      )}

      {data && data.rowCount === 0 && (
        <p className="text-sm text-slate-500">
          {t('accountDetail.empty', { start: data.start, end: data.end })}
        </p>
      )}

      {data && data.rowCount > 0 && (
        <>
          <ReportHeader meta={meta} variant="card" />
          <div className="max-h-[70vh] overflow-auto rounded-md border border-slate-200 bg-white">
            <table className="kpb-sticky-thead w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">{t('common:date')}</th>
                  <th className="px-4 py-2 text-left font-medium">
                    {t('accountDetail.columns.sourceDoc')}
                  </th>
                  <th className="px-4 py-2 text-left font-medium">{t('common:memo')}</th>
                  <th className="px-4 py-2 text-left font-medium">
                    {t('accountDetail.columns.counterparty')}
                  </th>
                  <th className="px-4 py-2 text-right font-medium">{t('common:debit')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('common:credit')}</th>
                  <th className="px-4 py-2 text-right font-medium">
                    {t('accountDetail.columns.runningBalance')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                <tr className="bg-slate-50 text-slate-600">
                  <td colSpan={6} className="px-4 py-2 text-right">
                    {data.offset > 0
                      ? t('accountDetail.broughtForward')
                      : t('accountDetail.openingBalance')}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">
                    {formatUsd(data.pageOpeningBalance)}
                  </td>
                </tr>
                {data.rows.map((r) => (
                  <tr key={r.lineId}>
                    <DetailCells row={r} />
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-100 text-sm font-semibold">
                <tr>
                  <td colSpan={4} className="px-4 py-2 text-right text-slate-700">
                    {t('accountDetail.periodTotals')}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(data.totalDebit)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(data.totalCredit)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(data.closingBalance)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-500">
              <p>
                {t('accountDetail.showing', {
                  first: data.offset + 1,
                  last: data.offset + data.returnedRows,
                  // Named `total`, not `count`: i18next treats `count` as the
                  // plural selector and this string has no plural forms.
                  total: data.rowCount,
                })}
              </p>
              {data.truncated && <p>{t('accountDetail.fullRangeNote')}</p>}
            </div>
            {data.truncated && (
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={data.offset === 0 || query.isFetching}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  className={pagerClass}
                >
                  {t('common:previous')}
                </button>
                <button
                  type="button"
                  disabled={!data.hasMore || query.isFetching}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                  className={pagerClass}
                >
                  {t('common:next')}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export function GeneralLedger({
  onOpenAccount,
}: {
  onOpenAccount?: ((target: AccountDrillTarget) => void) | undefined;
}) {
  const { t } = useTranslation(['reports', 'common']);
  const { companyId } = useCurrentCompany();
  const [start, setStart] = useState<string>(firstOfYear);
  const [end, setEnd] = useState<string>(todayIso);
  const [accountId, setAccountId] = useState<string>('');
  const [screenCap, setScreenCap] = useState(SCREEN_ROW_CAP);

  const accountsQuery = useQuery({
    queryKey: ['accounts', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ accounts: Account[] }>('/ledger/accounts', { companyId }),
  });
  // Inactive accounts stay in the picker: the general ledger reports them too,
  // and a deactivated account with history is exactly what a preparer hunts for.
  const accountOptions = useMemo(
    () => (accountsQuery.data?.accounts ?? []).slice().sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQuery.data],
  );

  const query = useQuery({
    queryKey: ['general-ledger', companyId, start, end, accountId],
    enabled: Boolean(companyId) && Boolean(start) && Boolean(end),
    queryFn: () =>
      api<GeneralLedgerResponse>(
        `/ledger/reports/general-ledger?start=${start}&end=${end}` +
          (accountId ? `&accountId=${accountId}` : ''),
        { companyId },
      ),
  });

  const data = query.data;
  const selectedAccount = accountOptions.find((a) => a.id === accountId);
  const accountLabel = selectedAccount
    ? `${selectedAccount.code} — ${selectedAccount.name}`
    : t('generalLedger.allAccounts');

  /**
   * The groups as PAINTED — the detail rows cut to a screen budget, spent in
   * account order. Nothing is dropped from the data: csvRows() below reads
   * `data.accounts`, so the export is always the full response. A group that
   * gets cut is marked `truncated`, which lights the account's own "N more
   * rows" line, so the table never quietly shortens itself.
   */
  const paintedAccounts = useMemo(() => {
    if (!data) return [];
    let budget = screenCap;
    return data.accounts.map((g) => {
      if (budget >= g.rows.length) {
        budget -= g.rows.length;
        return g;
      }
      const rows = budget > 0 ? g.rows.slice(0, budget) : [];
      budget = 0;
      return { ...g, rows, truncated: true };
    });
  }, [data, screenCap]);
  const paintedRows = Math.min(screenCap, data?.returnedRows ?? 0);

  /** Every group exactly as rendered: header, lines, per-account total. */
  function csvRows(): CsvRow[] {
    if (!data) return [];
    const out: CsvRow[] = [];
    // The row cap matters more in a file than on screen — the detail lines are
    // cut but every balance below is still exact, and only this note says so.
    if (data.truncated) {
      out.push([
        t('generalLedger.truncated', {
          returned: data.returnedRows,
          total: data.totalRowCount,
          cap: data.rowCap,
        }),
      ]);
      out.push([]);
    }
    out.push([t('generalLedger.summary', { count: data.totals.accountCount })]);
    out.push([
      t('common:date'),
      t('accountDetail.columns.sourceDoc'),
      t('common:memo'),
      t('accountDetail.columns.counterparty'),
      t('common:debit'),
      t('common:credit'),
      t('accountDetail.columns.runningBalance'),
    ]);

    for (const g of data.accounts) {
      out.push([
        g.code,
        g.name,
        t(`accountTypes.${g.type}`),
        g.isActive ? '' : t('accounts.inactiveTag'),
        '',
        t('accountDetail.openingBalance'),
        csvMoney(g.openingBalance),
      ]);
      if (g.rowCount === 0) out.push([t('generalLedger.noActivity')]);
      for (const r of g.rows) out.push(detailCsvRow(r, t));
      if (g.truncated) {
        out.push([t('generalLedger.accountTruncated', { count: g.rowCount - g.rows.length })]);
      }
      out.push([
        t('generalLedger.accountTotal', { code: g.code }),
        '',
        '',
        '',
        csvMoney(g.totalDebit),
        csvMoney(g.totalCredit),
        csvMoney(g.closingBalance),
      ]);
    }

    out.push([
      t('totals'),
      '',
      '',
      '',
      csvMoney(data.totals.totalDebit),
      csvMoney(data.totals.totalCredit),
      '',
    ]);
    return out;
  }

  const meta: ReportMeta = {
    title: t('generalLedger.title'),
    ...(data ? { start: data.start, end: data.end } : {}),
    // Which accounts the picker was narrowed to, or "All accounts".
    extra: [[t('common:account'), accountLabel]],
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">
          {t('generalLedger.title')}
        </h2>
      </div>
      <p className="max-w-4xl text-xs text-slate-500">{t('generalLedger.description')}</p>

      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('common:from')}>
          <input
            type="date"
            value={start}
            onChange={(e) => {
              setStart(e.target.value);
              setScreenCap(SCREEN_ROW_CAP);
            }}
            className={inputClass}
          />
        </Field>
        <Field label={t('common:to')}>
          <input
            type="date"
            value={end}
            onChange={(e) => {
              setEnd(e.target.value);
              setScreenCap(SCREEN_ROW_CAP);
            }}
            className={inputClass}
          />
        </Field>
        <Field label={t('common:account')}>
          <select
            value={accountId}
            onChange={(e) => {
              setAccountId(e.target.value);
              setScreenCap(SCREEN_ROW_CAP);
            }}
            className={inputClass}
          >
            <option value="">{t('generalLedger.allAccounts')}</option>
            {accountOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
                {a.isActive ? '' : ` ${t('accounts.inactiveTag')}`}
              </option>
            ))}
          </select>
        </Field>
        <ReportExportButtons
          filename={reportFilename('general-ledger', data?.start, data?.end)}
          meta={meta}
          rows={csvRows}
          disabled={query.isLoading || !data || data.accounts.length === 0}
        />
      </div>

      {query.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {query.isError && (
        // See AccountDetail above — the raw `API 500` never reaches the reader.
        <p
          className="text-sm text-rose-600"
          title={query.error instanceof Error ? query.error.message : undefined}
        >
          {t('generalLedger.loadError')}
        </p>
      )}

      {data && data.accounts.length === 0 && (
        <p className="text-sm text-slate-500">
          {t('generalLedger.empty', { start: data.start, end: data.end })}
        </p>
      )}

      {data && data.truncated && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {t('generalLedger.truncated', {
            returned: data.returnedRows,
            total: data.totalRowCount,
            cap: data.rowCap,
          })}
        </p>
      )}

      {data && data.accounts.length > 0 && (
        <>
          <ReportHeader meta={meta} variant="card" />
          <p className="text-xs text-slate-500">
            {t('generalLedger.summary', { count: data.totals.accountCount })}
          </p>
          <div className="max-h-[70vh] overflow-auto rounded-md border border-slate-200 bg-white">
            <table className="kpb-sticky-thead w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">{t('common:date')}</th>
                  <th className="px-4 py-2 text-left font-medium">
                    {t('accountDetail.columns.sourceDoc')}
                  </th>
                  <th className="px-4 py-2 text-left font-medium">{t('common:memo')}</th>
                  <th className="px-4 py-2 text-left font-medium">
                    {t('accountDetail.columns.counterparty')}
                  </th>
                  <th className="px-4 py-2 text-right font-medium">{t('common:debit')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('common:credit')}</th>
                  <th className="px-4 py-2 text-right font-medium">
                    {t('accountDetail.columns.runningBalance')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {paintedAccounts.flatMap((g) => [
                  <tr key={`hdr-${g.accountId}`} className="bg-slate-50">
                    <td colSpan={4} className="px-4 py-2">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="font-mono text-xs text-slate-500">{g.code}</span>
                        {onOpenAccount ? (
                          <button
                            type="button"
                            className={drillButtonClass + ' text-sm font-medium text-slate-900'}
                            aria-label={t('drill.openAccount', { code: g.code, name: g.name })}
                            onClick={() =>
                              onOpenAccount({ accountId: g.accountId, start, end })
                            }
                          >
                            {g.name}
                          </button>
                        ) : (
                          <span className="text-sm font-medium text-slate-900">{g.name}</span>
                        )}
                        <span className="text-xs text-slate-500">
                          {t(`accountTypes.${g.type}`)}
                        </span>
                        {!g.isActive && (
                          <span className="text-xs text-slate-400">{t('accounts.inactiveTag')}</span>
                        )}
                      </div>
                    </td>
                    <td colSpan={3} className="px-4 py-2 text-right">
                      <span className="text-xs uppercase tracking-wider text-slate-500">
                        {t('accountDetail.openingBalance')}
                      </span>{' '}
                      <span className="font-mono text-sm text-slate-700">
                        {formatUsd(g.openingBalance)}
                      </span>
                    </td>
                  </tr>,
                  ...(g.rowCount === 0
                    ? [
                        <tr key={`none-${g.accountId}`}>
                          <td colSpan={7} className="px-4 py-2 text-slate-500">
                            {t('generalLedger.noActivity')}
                          </td>
                        </tr>,
                      ]
                    : g.rows.map((r) => (
                        <tr key={r.lineId}>
                          <DetailCells row={r} />
                        </tr>
                      ))),
                  ...(g.truncated
                    ? [
                        <tr key={`trunc-${g.accountId}`}>
                          <td colSpan={7} className="px-4 py-2 text-xs text-amber-700">
                            {t('generalLedger.accountTruncated', {
                              count: g.rowCount - g.rows.length,
                            })}
                          </td>
                        </tr>,
                      ]
                    : []),
                  <tr key={`tot-${g.accountId}`} className="bg-slate-50 font-medium">
                    <td colSpan={4} className="px-4 py-2 text-right text-slate-700">
                      {t('generalLedger.accountTotal', { code: g.code })}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-900">
                      {formatUsd(g.totalDebit)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-900">
                      {formatUsd(g.totalCredit)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-900">
                      {formatUsd(g.closingBalance)}
                    </td>
                  </tr>,
                ])}
              </tbody>
              <tfoot className="bg-slate-100 text-sm font-semibold">
                <tr>
                  <td colSpan={4} className="px-4 py-2 text-right text-slate-700">
                    {t('totals')}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(data.totals.totalDebit)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(data.totals.totalCredit)}
                  </td>
                  <td className="px-4 py-2" />
                </tr>
              </tfoot>
            </table>
          </div>

          {data.returnedRows > paintedRows && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-500">
                {t('generalLedger.screenCapped', {
                  shown: paintedRows,
                  total: data.returnedRows,
                })}
              </p>
              <button
                type="button"
                onClick={() => setScreenCap(data.returnedRows)}
                className={pagerClass}
              >
                {t('generalLedger.showAllRows')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The same seven cells as a CSV line. Lives beside DetailCells for the same
 * reason DetailCells exists: both reports render this row, so both must export
 * it identically. The source-doc column collapses type, number and the
 * reversal tag into one cell, exactly as the table shows them.
 */
function detailCsvRow(row: LedgerDetailRow, t: TFunction<['reports', 'common']>): CsvRow {
  const doc = [t(`documentTypes.${row.documentType}`), row.documentNumber ?? '']
    .filter(Boolean)
    .join(' ');
  return [
    row.entryDate,
    row.isReversal ? `${doc} (${t('accountDetail.reversal')})` : doc,
    row.memo ?? '',
    row.counterpartyName ?? '',
    csvSide(row.debit),
    csvSide(row.credit),
    csvMoney(row.runningBalance),
  ];
}

/** The seven cells of one ledger line — identical on both reports. */
function DetailCells({ row }: { row: LedgerDetailRow }) {
  const { t } = useTranslation('reports');
  return (
    <>
      <td className="whitespace-nowrap px-4 py-2 font-mono text-slate-500">{row.entryDate}</td>
      <td className="px-4 py-2 text-slate-700">
        <span className="text-slate-900">{t(`documentTypes.${row.documentType}`)}</span>
        {row.documentNumber && (
          <span className="ml-1 font-mono text-slate-500">{row.documentNumber}</span>
        )}
        {row.isReversal && (
          <span className="ml-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20">
            {t('accountDetail.reversal')}
          </span>
        )}
      </td>
      <td className="max-w-[22rem] truncate px-4 py-2 text-slate-600" title={row.memo ?? undefined}>
        {row.memo ?? ''}
      </td>
      <td className="px-4 py-2 text-slate-700">{row.counterpartyName ?? ''}</td>
      <td className="px-4 py-2 text-right font-mono text-slate-900">{formatSide(row.debit)}</td>
      <td className="px-4 py-2 text-right font-mono text-slate-900">{formatSide(row.credit)}</td>
      <td
        className={
          'px-4 py-2 text-right font-mono ' +
          (Number(row.runningBalance) < 0 ? 'text-rose-700' : 'text-slate-700')
        }
      >
        {formatUsd(row.runningBalance)}
      </td>
    </>
  );
}

function Tile({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={
        'rounded-md border px-3 py-2 ' +
        (emphasis ? 'border-slate-300 bg-slate-50' : 'border-slate-200 bg-white')
      }
    >
      <p className="text-xs uppercase tracking-wider text-slate-500">{label}</p>
      <p className="font-mono text-sm font-medium text-slate-900">{value}</p>
    </div>
  );
}

const inputClass =
  'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-slate-900 focus:outline-none';

const pagerClass =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-white';

/**
 * Shared with the three summary reports so every drill-down affordance looks
 * and behaves identically. The row carries the mouse target; the button inside
 * it is what keeps the drill-down reachable from the keyboard.
 */
export const drillButtonClass =
  'rounded text-left underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500';
export const drillRowClass = 'cursor-pointer transition-colors hover:bg-sky-50 focus-within:bg-sky-50';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm text-slate-600">
      <span>{label}</span>
      {children}
    </label>
  );
}
