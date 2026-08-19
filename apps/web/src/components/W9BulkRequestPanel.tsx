import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface EligibleRow {
  vendorId: string;
  displayName: string;
  email: string | null;
  taxId: string | null;
  yearTotal: string;
  hasW9: boolean;
  hasActiveToken: boolean;
}

interface CreatedToken {
  id: string;
  token: string;
  expiresAt: string;
  vendorId: string;
  vendorName: string;
  emailTo: string | null;
  reused: boolean;
}

function formatUsd(s: string | number): string {
  const n = typeof s === 'number' ? s : Number(s);
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function buildUploadUrl(token: string): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.origin}/w9-upload/${token}`;
}

function buildMailToHref(token: CreatedToken, subject: string, body: string): string {
  const to = token.emailTo ? encodeURIComponent(token.emailTo) : '';
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export function W9BulkRequestPanel({
  year,
  companyName,
}: {
  year: number;
  companyName: string | null;
}) {
  const { t } = useTranslation(['purchases', 'common']);
  const { companyId } = useCurrentCompany();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [generated, setGenerated] = useState<CreatedToken[] | null>(null);

  const eligibleQ = useQuery({
    queryKey: ['w9-bulk-eligible', companyId, year],
    enabled: Boolean(companyId) && open,
    queryFn: () =>
      api<{ year: number; eligible: EligibleRow[] }>(
        `/w9-bulk/eligible?year=${year}`,
        { companyId },
      ),
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      const vendorIds = Array.from(selected);
      return api<{ tokens: CreatedToken[]; count: number }>(`/w9-bulk/generate`, {
        method: 'POST',
        companyId,
        body: {
          year,
          ...(vendorIds.length > 0 ? { vendorIds } : {}),
        },
      });
    },
    onSuccess: (data) => {
      setGenerated(data.tokens);
    },
  });

  const eligible = eligibleQ.data?.eligible ?? [];
  const allIds = eligible.map((e) => e.vendorId);
  const selectedCount = selected.size === 0 ? eligible.length : selected.size; // empty = all

  function toggleAll() {
    setSelected((prev) =>
      prev.size === allIds.length ? new Set() : new Set(allIds),
    );
  }
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-800 hover:bg-violet-100"
      >
        {t('w9Bulk.openCta')}
      </button>
    );
  }

  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{t('w9Bulk.title', { year })}</h3>
          <p className="text-xs text-slate-600">{t('w9Bulk.description', { year })}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setGenerated(null);
            setSelected(new Set());
            generateMutation.reset();
          }}
          className="text-xs text-slate-500 underline hover:text-slate-700"
        >
          {t('w9Bulk.close')}
        </button>
      </div>

      {eligibleQ.isLoading && (
        <p className="mt-3 text-sm text-slate-500">{t('w9Bulk.loadingEligible')}</p>
      )}
      {eligibleQ.isError && (
        <p className="mt-3 text-sm text-rose-600">
          {eligibleQ.error instanceof Error ? eligibleQ.error.message : t('w9Bulk.loadFailed')}
        </p>
      )}

      {!eligibleQ.isLoading && eligible.length === 0 && (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {t('w9Bulk.allCovered', { year })}
        </div>
      )}

      {!generated && eligible.length > 0 && (
        <>
          <div className="mt-3 overflow-hidden rounded-md border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="w-8 px-3 py-2 text-left">
                    <input
                      type="checkbox"
                      checked={selected.size === allIds.length}
                      onChange={toggleAll}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('w9Bulk.table.contractor')}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('w9Bulk.table.emailOnFile')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t('w9Bulk.table.paid', { year })}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">{t('w9Bulk.table.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {eligible.map((e) => {
                  const checked = selected.size === 0 || selected.has(e.vendorId);
                  return (
                    <tr key={e.vendorId}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleOne(e.vendorId)}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                      </td>
                      <td className="px-3 py-2 text-slate-900">{e.displayName}</td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {e.email ?? (
                          <span className="text-rose-600">{t('w9Bulk.emailMissingLong')}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-900">
                        {formatUsd(e.yearTotal)}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {e.hasActiveToken ? (
                          <span className="rounded-md bg-amber-50 px-2 py-0.5 text-amber-700 ring-1 ring-amber-600/20">
                            {t('w9Bulk.linkActive')}
                          </span>
                        ) : (
                          <span className="text-slate-500">{t('w9Bulk.noLinkYet')}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {generateMutation.isPending
                ? t('w9Bulk.generatingLinks')
                : selected.size === 0
                  ? t('w9Bulk.generateAll')
                  : t('w9Bulk.generateSelected', { count: selected.size })}
            </button>
            <p className="text-xs text-slate-500">
              {selected.size === 0
                ? t('w9Bulk.willMintAll', { count: eligible.length })
                : t('w9Bulk.selectedOf', { count: selected.size, total: eligible.length })}{' '}
              {t('w9Bulk.reuseHint')}
            </p>
          </div>

          {generateMutation.isError && (
            <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formatError(generateMutation.error, {
                error: t('errors.label'),
                fallback: t('errors.failed'),
              })}
            </div>
          )}
        </>
      )}

      {generated && (
        <div className="mt-3 space-y-3">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            <Trans
              t={t}
              i18nKey="w9Bulk.generatedBanner"
              count={generated.length}
              values={{ count: generated.length }}
              components={{ strong: <strong /> }}
            />
          </div>

          <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('w9Bulk.table.contractor')}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">{t('w9Bulk.table.email')}</th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('w9Bulk.table.uploadUrl')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {generated.map((row) => {
                  const url = buildUploadUrl(row.token);
                  return (
                    <tr key={row.id}>
                      <td className="px-3 py-2 text-slate-900">
                        {row.vendorName}
                        {row.reused && (
                          <span className="ml-2 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700 ring-1 ring-amber-600/20">
                            {t('w9Bulk.reusedBadge')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {row.emailTo ?? (
                          <span className="text-rose-600">{t('w9Bulk.emailMissing')}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px]">
                        <span className="block truncate" title={url}>
                          {url}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => navigator.clipboard.writeText(url)}
                            className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                          >
                            {t('w9Bulk.copy')}
                          </button>
                          <a
                            href={buildMailToHref(
                              row,
                              t('w9Email.subject', {
                                company: companyName ?? t('w9Email.fallbackCompany'),
                              }),
                              t('w9Email.bodyShort', { vendor: row.vendorName, url }),
                            )}
                            className="rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white hover:bg-slate-800"
                          >
                            {t('w9Bulk.emailCta')}
                          </a>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => {
                setGenerated(null);
                setSelected(new Set());
                generateMutation.reset();
                void eligibleQ.refetch();
              }}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              {t('w9Bulk.refreshEligibility')}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              {t('common:close')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatError(err: unknown, labels: { error: string; fallback: string }): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? labels.error}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : labels.fallback;
}
