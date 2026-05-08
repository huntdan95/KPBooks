import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
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

function buildMailToHref(token: CreatedToken, companyName: string | null): string {
  const url = buildUploadUrl(token.token);
  const subject = encodeURIComponent(`W-9 needed for ${companyName ?? 'your work'}`);
  const body = encodeURIComponent(
    `Hi ${token.vendorName},\n\n` +
      `For year-end 1099 reporting we need a current Form W-9 on file. ` +
      `Please upload yours via the secure link below — no account needed:\n\n` +
      `${url}\n\n` +
      `Thanks!`,
  );
  const to = token.emailTo ? encodeURIComponent(token.emailTo) : '';
  return `mailto:${to}?subject=${subject}&body=${body}`;
}

export function W9BulkRequestPanel({
  year,
  companyName,
}: {
  year: number;
  companyName: string | null;
}) {
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
        Request W-9s in bulk
      </button>
    );
  }

  return (
    <div className="rounded-md border border-violet-200 bg-violet-50/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">
            Bulk W-9 reminder for {year}
          </h3>
          <p className="text-xs text-slate-600">
            Generates a single-use upload link for each contractor paid $600+ in {year} who has
            no W-9 on file. The contractor opens the link in any browser, uploads their W-9, and
            the document goes straight onto their Worker page. No login required for them.
          </p>
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
          close
        </button>
      </div>

      {eligibleQ.isLoading && (
        <p className="mt-3 text-sm text-slate-500">Loading eligible contractors…</p>
      )}
      {eligibleQ.isError && (
        <p className="mt-3 text-sm text-rose-600">
          {eligibleQ.error instanceof Error ? eligibleQ.error.message : 'Failed to load.'}
        </p>
      )}

      {!eligibleQ.isLoading && eligible.length === 0 && (
        <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          ✓ Every {year} 1099 contractor over $600 already has a W-9 on file. Nothing to do.
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
                  <th className="px-3 py-2 text-left font-medium">Contractor</th>
                  <th className="px-3 py-2 text-left font-medium">Email on file</th>
                  <th className="px-3 py-2 text-right font-medium">Paid {year}</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
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
                          <span className="text-rose-600">missing — add on Worker page</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-900">
                        {formatUsd(e.yearTotal)}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {e.hasActiveToken ? (
                          <span className="rounded-md bg-amber-50 px-2 py-0.5 text-amber-700 ring-1 ring-amber-600/20">
                            existing link active
                          </span>
                        ) : (
                          <span className="text-slate-500">no link yet</span>
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
                ? 'Generating links…'
                : `Generate ${selected.size === 0 ? 'all' : selected.size} link${
                    selected.size === 1 ? '' : 's'
                  }`}
            </button>
            <p className="text-xs text-slate-500">
              {selected.size === 0
                ? `Will mint links for all ${eligible.length} contractor${
                    eligible.length === 1 ? '' : 's'
                  }.`
                : `Selected: ${selected.size} of ${eligible.length}.`}{' '}
              Re-uses any active link rather than creating duplicates.
            </p>
          </div>

          {generateMutation.isError && (
            <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formatError(generateMutation.error)}
            </div>
          )}
        </>
      )}

      {generated && (
        <div className="mt-3 space-y-3">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            ✓ Generated {generated.length} upload link{generated.length === 1 ? '' : 's'}. Click
            <strong> Email </strong> on each row to compose a pre-filled message in your default
            mail client.
          </div>

          <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Contractor</th>
                  <th className="px-3 py-2 text-left font-medium">Email</th>
                  <th className="px-3 py-2 text-left font-medium">Upload URL</th>
                  <th className="px-3 py-2 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {generated.map((t) => {
                  const url = buildUploadUrl(t.token);
                  return (
                    <tr key={t.id}>
                      <td className="px-3 py-2 text-slate-900">
                        {t.vendorName}
                        {t.reused && (
                          <span className="ml-2 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700 ring-1 ring-amber-600/20">
                            reused
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {t.emailTo ?? <span className="text-rose-600">missing</span>}
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
                            Copy
                          </button>
                          <a
                            href={buildMailToHref(t, companyName)}
                            className="rounded-md bg-slate-900 px-2 py-1 text-xs font-medium text-white hover:bg-slate-800"
                          >
                            Email
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
              Refresh eligibility
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? 'Error'}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : 'Failed.';
}
