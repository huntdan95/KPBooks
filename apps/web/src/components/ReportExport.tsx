/**
 * The Export CSV control every report carries.
 *
 * One component, so all eleven reports look and behave alike and — more to the
 * point — so the header block is written once. A bare grid of numbers is
 * useless to whoever opens the file a month later: every export leads with what
 * report it is, whose books, over what dates, and on which basis.
 *
 * Rows are built on click rather than on every render: a general ledger export
 * is thousands of rows and nobody has asked for it until the button is pressed.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { downloadCsv } from '../lib/report-export';

/** One CSV line. Numbers stay unformatted so Excel can sum the column. */
export type CsvRow = Array<string | number | null | undefined>;

export interface ReportMeta {
  /** Already-translated report name. */
  title: string;
  /** Range reports pass both; as-of reports pass `asOf` instead. */
  start?: string;
  end?: string;
  asOf?: string;
  /** Already-translated basis label. Omitted where a report has no basis. */
  basis?: string;
  /**
   * Extra label/value context lines — an account filter, a horizon, a
   * classification filter. Anything that changes which rows are below and
   * would otherwise be invisible in the file.
   */
  extra?: CsvRow[];
}

/**
 * Money for a spreadsheet cell: the server's own decimal string, cut to cents,
 * with no currency symbol and no thousands separator. Deliberately never a JS
 * number — the value stays a string end to end, so no float ever touches it,
 * and Excel still reads the cell as a number. Truncating (rather than rounding)
 * the fraction is what formatUsd does on screen, so the file matches the page.
 */
export function csvMoney(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const [whole = '0', frac = ''] = String(value).split('.');
  return `${whole}.${(frac + '00').slice(0, 2)}`;
}

/** A debit/credit cell: blank when the side is unused, exactly as on screen. */
export function csvSide(value: string | null | undefined): string {
  return Number(value) > 0 ? csvMoney(value) : '';
}

export function ExportCsvButton({
  filename,
  meta,
  rows,
  disabled,
}: {
  /** Stem from reportFilename(); the .csv suffix is added for you. */
  filename: string;
  meta: ReportMeta;
  /**
   * Called on click — the rows exactly as the table renders them. May be async:
   * a report whose screen view is one page of a larger range refetches the
   * whole range here rather than exporting a file that does not cross-foot.
   */
  rows: () => CsvRow[] | Promise<CsvRow[]>;
  /** True while the report is loading or has nothing to export. */
  disabled: boolean;
}) {
  const { t } = useTranslation('reports');
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  // Same query key Period Close and Mileage use, so this reads their cached
  // company instead of firing a request of its own.
  const companyQuery = useQuery({
    queryKey: ['company-current', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ name: string }>('/companies/current', { companyId }),
  });

  /**
   * Whose books this is. /companies/current is the better source but nothing
   * waits on it — the button unlocks as soon as the REPORT resolves, and a 4xx
   * on that request never retries — so falling back on it alone ships files
   * whose Company line is blank, which is the one thing the header block exists
   * to prevent. The membership list is guaranteed: the whole shell is gated on
   * ['me'] before any report can render.
   */
  function companyName(): string {
    const current = companyQuery.data?.name;
    if (current) return current;
    const me = queryClient.getQueryData<{
      memberships?: Array<{ companyId: string; companyName: string }>;
    }>(['me']);
    return me?.memberships?.find((m) => m.companyId === companyId)?.companyName ?? '';
  }

  async function onExport() {
    const header: CsvRow[] = [
      [t('export.meta.report'), meta.title],
      [t('export.meta.company'), companyName()],
    ];
    if (meta.asOf) {
      header.push([t('export.meta.asOf'), meta.asOf]);
    } else {
      // Start and end get their own cells rather than one "a through b"
      // string: a CPA sorting or filtering the file needs real dates.
      header.push([t('export.meta.period'), meta.start ?? '', meta.end ?? '']);
    }
    if (meta.basis) header.push([t('export.meta.basis'), meta.basis]);
    if (meta.extra) header.push(...meta.extra);
    header.push([t('export.meta.generated'), new Date().toISOString().slice(0, 10)]);
    header.push([]);
    downloadCsv(filename, [...header, ...(await rows())]);
  }

  return (
    <button
      type="button"
      onClick={() => void onExport()}
      disabled={disabled}
      className={exportButtonClass}
    >
      {t('export.csv')}
    </button>
  );
}

// Same shape as the ledger pager buttons, so the control reads as part of the
// report toolbar rather than a call to action.
const exportButtonClass =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-white';
