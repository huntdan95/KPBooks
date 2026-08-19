import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { Generate1099Modal } from './Generate1099Modal';
import { W9BulkRequestPanel } from './W9BulkRequestPanel';

interface NinetyNineRow {
  vendorId: string;
  displayName: string;
  taxId: string | null;
  mailingAddress: Record<string, unknown> | null;
  total: string;
  meetsThreshold: boolean;
  missingTaxId: boolean;
}

interface NinetyNineReport {
  year: number;
  rows: NinetyNineRow[];
  totals: { total: string; aboveThreshold: number; missingTaxIdAboveThreshold: number };
}

const currentYear = () => new Date().getUTCFullYear();
const yearOptions = (() => {
  const cy = currentYear();
  // Tax forms run on the prior calendar year; default to that. Show ±5y.
  return Array.from({ length: 7 }, (_, i) => cy - i);
})();

function formatUsd(s: string): string {
  if (!s) return '$0.00';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

function formatAddress(a: Record<string, unknown> | null): string {
  if (!a || typeof a !== 'object') return '';
  const parts = [a.street1, a.street2, a.city && `${a.city}, ${a.state ?? ''} ${a.postalCode ?? ''}`]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
    .map((p) => p.trim());
  return parts.join(' · ');
}

export function NinetyNinePrep() {
  const { t } = useTranslation(['purchases', 'common']);
  const { companyId } = useCurrentCompany();
  // Default to the prior calendar year (the year you'd be filing for now).
  const [year, setYear] = useState<number>(currentYear() - 1);
  const [hideBelowThreshold, setHideBelowThreshold] = useState<boolean>(true);
  const [generateForVendorId, setGenerateForVendorId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['1099-summary', companyId, year],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<NinetyNineReport>(`/ledger/reports/1099-summary?year=${year}`, { companyId }),
  });

  const rows = query.data?.rows ?? [];
  const visible = hideBelowThreshold ? rows.filter((r) => r.meetsThreshold) : rows;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-base font-semibold tracking-tight text-slate-900">
          {t('ninetyNine.title')}
        </h3>
        <p className="text-sm text-slate-500">{t('ninetyNine.intro')}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 bg-white p-3">
        <label className="flex flex-col gap-1 text-sm text-slate-600">
          <span>{t('ninetyNine.taxYear')}</span>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-slate-900 focus:outline-none"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={hideBelowThreshold}
            onChange={(e) => setHideBelowThreshold(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          {t('ninetyNine.hideBelow')}
        </label>
      </div>

      <W9BulkRequestPanel year={year} companyName={null} />

      {query.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : t('ninetyNine.loadFailed')}
        </p>
      )}

      {query.data && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Stat
              label={t('ninetyNine.stats.atThreshold')}
              value={String(query.data.totals.aboveThreshold)}
              tone="emerald"
            />
            <Stat
              label={t('ninetyNine.stats.total')}
              value={formatUsd(query.data.totals.total)}
              tone="slate"
            />
            <Stat
              label={t('ninetyNine.stats.missingTaxIds')}
              value={String(query.data.totals.missingTaxIdAboveThreshold)}
              tone={query.data.totals.missingTaxIdAboveThreshold > 0 ? 'rose' : 'emerald'}
            />
          </div>

          {visible.length === 0 ? (
            <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
              {rows.length === 0
                ? t('ninetyNine.emptyNoPayments', { year })
                : t('ninetyNine.emptyBelowThreshold', { year })}
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('ninetyNine.table.vendor')}
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('ninetyNine.table.taxId')}
                    </th>
                    <th className="px-4 py-2 text-left font-medium">
                      {t('ninetyNine.table.mailingAddress')}
                    </th>
                    <th className="px-4 py-2 text-right font-medium">
                      {t('ninetyNine.table.totalPaid', { year })}
                    </th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {visible.map((r) => (
                    <tr
                      key={r.vendorId}
                      className={r.meetsThreshold ? '' : 'opacity-60'}
                    >
                      <td className="px-4 py-2 text-slate-900">
                        <div className="font-medium">{r.displayName}</div>
                        {!r.meetsThreshold && (
                          <div className="text-xs text-slate-500">
                            {t('ninetyNine.belowThreshold')}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs">
                        {r.taxId ? (
                          <span className="text-slate-700">{r.taxId}</span>
                        ) : r.meetsThreshold ? (
                          <span className="rounded-md bg-rose-50 px-2 py-0.5 text-rose-700 ring-1 ring-rose-200">
                            {t('ninetyNine.missing')}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-xs text-slate-600">
                        {formatAddress(r.mailingAddress) || '—'}
                      </td>
                      <td className="px-4 py-2 text-right font-mono text-slate-900">
                        {formatUsd(r.total)}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => setGenerateForVendorId(r.vendorId)}
                          disabled={!r.meetsThreshold}
                          className="rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                          title={
                            r.meetsThreshold
                              ? t('ninetyNine.generateTitle')
                              : t('ninetyNine.belowThresholdTitle')
                          }
                        >
                          {t('ninetyNine.generate')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-xs text-slate-500">
            {t('ninetyNine.footerPre')} <strong>{t('ninetyNine.generate')}</strong>{' '}
            {t('ninetyNine.footerPost')}
          </p>
        </>
      )}

      {generateForVendorId && (
        <Generate1099Modal
          vendorId={generateForVendorId}
          initialYear={year}
          onClose={() => setGenerateForVendorId(null)}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'emerald' | 'rose' | 'slate';
}) {
  const toneClass = {
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    rose: 'border-rose-200 bg-rose-50 text-rose-700',
    slate: 'border-slate-200 bg-white text-slate-900',
  }[tone];
  return (
    <div className={'rounded-md border p-3 ' + toneClass}>
      <div className="text-xs uppercase tracking-wider opacity-70">{label}</div>
      <div className="mt-1 font-mono text-xl">{value}</div>
    </div>
  );
}
