import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface Vendor {
  id: string;
  displayName: string;
  companyName: string | null;
  accountNumber: string | null;
  email: string | null;
  phone: string | null;
  defaultTermsDays: number | null;
  is1099Vendor: boolean;
  taxId: string | null;
  isActive: boolean;
  openingBalance: string;
}

interface CreateBody {
  displayName: string;
  companyName?: string | undefined;
  accountNumber?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  defaultTermsDays?: number | undefined;
  is1099Vendor: boolean;
  taxId?: string | undefined;
  notes?: string | undefined;
}

const blank: CreateBody = { displayName: '', is1099Vendor: false };

export function VendorsList() {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<CreateBody>(blank);

  const query = useQuery({
    queryKey: ['vendors', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ vendors: Vendor[] }>('/vendors', { companyId }),
  });

  const createMutation = useMutation({
    mutationFn: async (body: CreateBody) => {
      const cleaned: Record<string, unknown> = {
        displayName: body.displayName.trim(),
        is1099Vendor: body.is1099Vendor,
      };
      if (body.companyName?.trim()) cleaned.companyName = body.companyName.trim();
      if (body.accountNumber?.trim()) cleaned.accountNumber = body.accountNumber.trim();
      if (body.email?.trim()) cleaned.email = body.email.trim();
      if (body.phone?.trim()) cleaned.phone = body.phone.trim();
      if (body.notes?.trim()) cleaned.notes = body.notes.trim();
      if (body.taxId?.trim()) cleaned.taxId = body.taxId.trim();
      if (body.defaultTermsDays !== undefined) cleaned.defaultTermsDays = body.defaultTermsDays;
      return api<Vendor>('/vendors', { method: 'POST', companyId, body: cleaned });
    },
    onSuccess: () => {
      setDraft(blank);
      setShowForm(false);
      void queryClient.invalidateQueries({ queryKey: ['vendors', companyId] });
    },
  });

  const taxIdMissing = draft.is1099Vendor && !(draft.taxId ?? '').trim();
  const canSubmit = !!draft.displayName.trim() && !taxIdMissing;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    createMutation.mutate(draft);
  }

  const vendors = query.data?.vendors ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Vendors</h2>
          <p className="text-sm text-slate-500">{vendors.length} on file</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setShowForm((v) => !v);
            if (showForm) setDraft(blank);
          }}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          {showForm ? 'Cancel' : '+ New vendor'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={onSubmit}
          className="space-y-3 rounded-md border border-slate-200 bg-white p-4"
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Display name" required>
              <input
                type="text"
                value={draft.displayName}
                onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                maxLength={200}
                required
                autoFocus
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            </Field>
            <Field label="Company name">
              <input
                type="text"
                value={draft.companyName ?? ''}
                onChange={(e) => setDraft({ ...draft, companyName: e.target.value })}
                maxLength={200}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            </Field>
            <Field label="Account number">
              <input
                type="text"
                value={draft.accountNumber ?? ''}
                onChange={(e) => setDraft({ ...draft, accountNumber: e.target.value })}
                maxLength={40}
                placeholder="V-203"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                value={draft.email ?? ''}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                maxLength={200}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            </Field>
            <Field label="Phone">
              <input
                type="tel"
                value={draft.phone ?? ''}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                maxLength={40}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            </Field>
            <Field label="Default terms (days)">
              <input
                type="number"
                min={0}
                max={365}
                value={draft.defaultTermsDays ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    defaultTermsDays: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
                placeholder="30"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={draft.is1099Vendor}
              onChange={(e) => setDraft({ ...draft, is1099Vendor: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300"
            />
            1099-NEC vendor (will be included in year-end 1099 prep)
          </label>

          {draft.is1099Vendor && (
            <Field label="Tax ID (TIN/EIN)" required>
              <input
                type="text"
                value={draft.taxId ?? ''}
                onChange={(e) => setDraft({ ...draft, taxId: e.target.value })}
                maxLength={40}
                placeholder="12-3456789 or 123-45-6789"
                required
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            </Field>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!canSubmit || createMutation.isPending}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createMutation.isPending ? 'Saving…' : 'Save vendor'}
            </button>
            {taxIdMissing && (
              <span className="text-xs text-slate-500">Tax ID required for 1099 vendors.</span>
            )}
          </div>

          {createMutation.isError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formatError(createMutation.error)}
            </div>
          )}
        </form>
      )}

      {query.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : 'Failed to load vendors.'}
        </p>
      )}

      {vendors.length === 0 && !query.isLoading && (
        <p className="text-sm text-slate-500">No vendors yet. Add one above.</p>
      )}

      {vendors.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Account #</th>
                <th className="px-4 py-2 text-left font-medium">Display name</th>
                <th className="px-4 py-2 text-left font-medium">Email</th>
                <th className="px-4 py-2 text-left font-medium">Phone</th>
                <th className="px-4 py-2 text-right font-medium">Terms</th>
                <th className="px-4 py-2 text-center font-medium">1099</th>
                <th className="px-4 py-2 text-right font-medium">Opening balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {vendors.map((v) => (
                <tr key={v.id} className={v.isActive ? '' : 'opacity-60'}>
                  <td className="px-4 py-2 font-mono text-slate-500">{v.accountNumber ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-900">
                    <div className="font-medium">{v.displayName}</div>
                    {v.companyName && <div className="text-xs text-slate-500">{v.companyName}</div>}
                  </td>
                  <td className="px-4 py-2 text-slate-700">{v.email ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-700">{v.phone ?? '—'}</td>
                  <td className="px-4 py-2 text-right text-slate-700">
                    {v.defaultTermsDays === null ? '—' : `Net ${v.defaultTermsDays}`}
                  </td>
                  <td className="px-4 py-2 text-center text-slate-700">
                    {v.is1099Vendor ? '✓' : '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">
                    {Number(v.openingBalance) === 0 ? '—' : v.openingBalance}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-rose-600">*</span>}
      </span>
      {children}
    </label>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string; details?: unknown } | null;
    if (body?.message) return `${body.error ?? 'Error'}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : 'Failed to save.';
}
