/**
 * The block every report leads with.
 *
 * QuickBooks puts the company on top of the report itself rather than in the
 * chrome around it, and for a good reason: the report is the thing that gets
 * printed, screenshotted, emailed to a lender and filed with a return. A page
 * of numbers that does not say whose books it is, over what dates, and on which
 * basis is not a document — it is a screenshot of a filter.
 *
 * The same `meta` object drives this header, the CSV header block and the PDF
 * masthead, so the three can never drift apart.
 */
import { useTranslation } from 'react-i18next';
import {
  type CompanyProfile,
  companyAddressLines,
  companyContactLine,
  useCompanyProfile,
} from '../lib/company-profile';
import { type ReportMeta, formatLongDate } from '../lib/report-export';

export interface ReportHeading {
  profile: CompanyProfile;
  /** Company name as it goes on the masthead. */
  name: string;
  /** Legal name (when it differs), address, phone/EIN — in print order. */
  lines: string[];
  title: string;
  /** "January 1 through August 25, 2026", or "As of August 25, 2026". */
  subtitle: string;
  /** Basis, when the report has one. */
  qualifier: string;
  /** meta.extra flattened to "Label: value" lines. */
  context: string[];
}

/**
 * Everything the masthead needs, composed once. Shared with the export buttons
 * so the PDF says exactly what the screen says.
 */
export function useReportHeading(meta: ReportMeta): ReportHeading {
  const { t, i18n } = useTranslation('reports');
  const profile = useCompanyProfile();
  const lang = i18n.language;

  const lines: string[] = [];
  // The legal name only earns a line when it is not just the company name
  // again — "Acme Landscaping LLC" twice is noise, "d/b/a" information is not.
  if (profile.legalName && profile.legalName !== profile.name) lines.push(profile.legalName);
  lines.push(...companyAddressLines(profile.address));
  const contact = companyContactLine(profile, t('header.ein'));
  if (contact) lines.push(contact);

  const subtitle = meta.asOf
    ? t('header.asOf', { date: formatLongDate(meta.asOf, lang) })
    : meta.start || meta.end
      ? t('header.period', {
          start: formatLongDate(meta.start, lang),
          end: formatLongDate(meta.end, lang),
        })
      : '';

  const context = (meta.extra ?? [])
    .map((row) => row.map((c) => String(c ?? '')).filter((c) => c !== ''))
    .filter((cells) => cells.length > 0)
    .map((cells) => (cells.length > 1 ? `${cells[0]}: ${cells.slice(1).join(' ')}` : cells[0] ?? ''));

  return {
    profile,
    name: profile.name,
    lines,
    title: meta.title,
    subtitle,
    qualifier: meta.basis ?? '',
    context,
  };
}

/**
 * Renders the heading. Drop it directly above a report's table, inside the same
 * card, so a copy-paste or a screenshot of the card carries the identification
 * with it.
 */
export function ReportHeader({ meta }: { meta: ReportMeta }) {
  const heading = useReportHeading(meta);

  return (
    <header className="border-b border-slate-200 bg-white px-4 py-5 text-center">
      {heading.name && (
        <p className="text-lg font-semibold tracking-tight text-slate-900">{heading.name}</p>
      )}
      {heading.lines.map((line) => (
        <p key={line} className="text-xs text-slate-500">
          {line}
        </p>
      ))}

      <h3 className="mt-3 text-base font-semibold tracking-tight text-slate-900">
        {heading.title}
      </h3>
      {heading.subtitle && <p className="text-sm text-slate-600">{heading.subtitle}</p>}
      {heading.qualifier && (
        <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
          {heading.qualifier}
        </p>
      )}
      {heading.context.map((line) => (
        <p key={line} className="text-xs text-slate-500">
          {line}
        </p>
      ))}
    </header>
  );
}
