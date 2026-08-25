/**
 * The export controls every report carries: CSV for a spreadsheet, PDF for a
 * page someone will read.
 *
 * One component, so all eleven reports look and behave alike and — more to the
 * point — so the header block is written once. A bare grid of numbers is
 * useless to whoever opens the file a month later: every export leads with what
 * report it is, whose books, over what dates, and on which basis. The PDF gets
 * the same facts as the printed masthead the screen already shows.
 *
 * Rows are built on click rather than on every render: a general ledger export
 * is thousands of rows and nobody has asked for it until a button is pressed.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type CsvRow, type ReportMeta, downloadCsv, formatLongDate } from '../lib/report-export';
import { downloadReportPdf } from '../lib/report-pdf';
import { useReportHeading } from './ReportHeader';

export type { CsvRow, ReportMeta };

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

export function ReportExportButtons({
  filename,
  meta,
  rows,
  disabled,
}: {
  /** Stem from reportFilename(); the .csv / .pdf suffix is added for you. */
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
  const { t, i18n } = useTranslation('reports');
  const heading = useReportHeading(meta);
  // The PDF has to pull in jsPDF before it can write anything, so the button
  // says so rather than looking dead for the length of a chunk download.
  const [busy, setBusy] = useState(false);

  const today = new Date().toISOString().slice(0, 10);

  async function onExportCsv() {
    const header: CsvRow[] = [
      [t('export.meta.report'), meta.title],
      [t('export.meta.company'), heading.name],
    ];
    if (meta.asOf) {
      header.push([t('export.meta.asOf'), meta.asOf]);
    } else {
      // Start and end get their own cells rather than one "a through b"
      // string: a CPA sorting or filtering the file needs real dates. Same
      // reason they stay ISO here while the PDF spells them out.
      header.push([t('export.meta.period'), meta.start ?? '', meta.end ?? '']);
    }
    if (meta.basis) header.push([t('export.meta.basis'), meta.basis]);
    if (meta.extra) header.push(...meta.extra);
    header.push([t('export.meta.generated'), today]);
    header.push([]);
    downloadCsv(filename, [...header, ...(await rows())]);
  }

  async function onExportPdf() {
    setBusy(true);
    try {
      await downloadReportPdf({
        filename,
        masthead: { name: heading.name, lines: heading.lines },
        title: heading.title,
        subtitle: heading.subtitle,
        qualifier: heading.qualifier,
        context: heading.context,
        generated: t('export.meta.generated') + ' ' + formatLongDate(today, i18n.language),
        pageLabel: (page, pages) => t('header.page', { page, pages }),
        continued: t('header.continued', { title: heading.title }),
        rows: await rows(),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void onExportCsv()}
        disabled={disabled}
        className={exportButtonClass}
      >
        {t('export.csv')}
      </button>
      <button
        type="button"
        onClick={() => void onExportPdf()}
        disabled={disabled || busy}
        className={exportButtonClass}
      >
        {busy ? t('export.pdfBusy') : t('export.pdf')}
      </button>
    </div>
  );
}

// Same shape as the ledger pager buttons, so the controls read as part of the
// report toolbar rather than a call to action.
const exportButtonClass =
  'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-white';
