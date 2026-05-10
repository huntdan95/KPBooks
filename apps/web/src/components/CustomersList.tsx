import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { CustomerDetail } from './CounterpartyDetail';
import { MergeDuplicatesModal } from './MergeDuplicatesModal';
import { StatementsPanel } from './StatementsPanel';
import { EmptyState } from './ui/EmptyState';

interface Customer {
  id: string;
  displayName: string;
  companyName: string | null;
  accountNumber: string | null;
  email: string | null;
  phone: string | null;
  defaultTermsDays: number | null;
  taxExempt: boolean;
  isActive: boolean;
  openingBalance: string;
  notes?: string | null;
}

interface FormDraft {
  displayName: string;
  companyName?: string | undefined;
  accountNumber?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  defaultTermsDays?: number | undefined;
  taxExempt: boolean;
  notes?: string | undefined;
  isActive: boolean;
}

type FormMode = null | { type: 'create' } | { type: 'edit'; id: string };

const emptyDraft: FormDraft = { displayName: '', taxExempt: false, isActive: true };

function rowToDraft(c: Customer): FormDraft {
  return {
    displayName: c.displayName,
    companyName: c.companyName ?? undefined,
    accountNumber: c.accountNumber ?? undefined,
    email: c.email ?? undefined,
    phone: c.phone ?? undefined,
    defaultTermsDays: c.defaultTermsDays ?? undefined,
    taxExempt: c.taxExempt,
    notes: c.notes ?? undefined,
    isActive: c.isActive,
  };
}

function buildPayload(draft: FormDraft, mode: 'create' | 'edit'): Record<string, unknown> {
  const out: Record<string, unknown> = {
    displayName: draft.displayName.trim(),
    taxExempt: draft.taxExempt,
  };
  out.companyName = draft.companyName?.trim() || null;
  out.accountNumber = draft.accountNumber?.trim() || null;
  out.email = draft.email?.trim() || null;
  out.phone = draft.phone?.trim() || null;
  out.notes = draft.notes?.trim() || null;
  out.defaultTermsDays =
    draft.defaultTermsDays === undefined ? null : draft.defaultTermsDays;
  if (mode === 'edit') out.isActive = draft.isActive;

  // For create, the API doesn't accept null for some fields — drop them so
  // server-side defaults apply. For PATCH, null = "clear this field".
  if (mode === 'create') {
    for (const k of Object.keys(out)) {
      if (out[k] === null) delete out[k];
    }
  }
  return out;
}

export function CustomersList() {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<FormMode>(null);
  const [draft, setDraft] = useState<FormDraft>(emptyDraft);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showMerge, setShowMerge] = useState<boolean>(false);

  // NOTE: every hook below MUST run on every render; do NOT add an early
  // `if (detailId) return ...` here -- that's a Rules-of-Hooks violation
  // (the hook count drops to 3 on the next render and React blanks the
  // page). The detail view branches off at the END after all hooks have
  // been called.
  const query = useQuery({
    queryKey: ['customers', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ customers: Customer[] }>('/customers', { companyId }),
  });

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === null) throw new Error('no mode');
      const payload = buildPayload(draft, mode.type);
      if (mode.type === 'create') {
        return api<Customer>('/customers', { method: 'POST', companyId, body: payload });
      }
      return api<Customer>(`/customers/${mode.id}`, { method: 'PATCH', companyId, body: payload });
    },
    onSuccess: () => {
      setMode(null);
      setDraft(emptyDraft);
      void queryClient.invalidateQueries({ queryKey: ['customers', companyId] });
    },
  });

  function startCreate() {
    setMode({ type: 'create' });
    setDraft(emptyDraft);
  }
  function startEdit(c: Customer) {
    setMode({ type: 'edit', id: c.id });
    setDraft(rowToDraft(c));
  }
  function cancel() {
    setMode(null);
    setDraft(emptyDraft);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.displayName.trim() || mutation.isPending) return;
    mutation.mutate();
  }

  const customers = query.data?.customers ?? [];

  // Branch AFTER all hooks have been called. Putting this branch above any
  // hook would cause React to render fewer hooks on the detail-view render
  // than on the list render -> "Rendered fewer hooks than expected." crash.
  if (detailId) {
    return <CustomerDetail customerId={detailId} onBack={() => setDetailId(null)} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Customers</h2>
          <p className="text-sm text-slate-500">{customers.length} on file</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowMerge(true)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            Merge duplicates…
          </button>
          <button
            type="button"
            onClick={mode ? cancel : startCreate}
            className="whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            {mode ? 'Cancel' : '+ New customer'}
          </button>
        </div>
      </div>

      {showMerge && (
        <MergeDuplicatesModal kind="customer" onClose={() => setShowMerge(false)} />
      )}

      <StatementsPanel />

      {mode && (
        <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-medium text-slate-700">
            {mode.type === 'create' ? 'New customer' : `Edit customer`}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Display name" required>
              <input
                type="text"
                value={draft.displayName}
                onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                maxLength={200}
                required
                autoFocus
                className={inputClass}
              />
            </Field>
            <Field label="Company name">
              <input
                type="text"
                value={draft.companyName ?? ''}
                onChange={(e) => setDraft({ ...draft, companyName: e.target.value })}
                maxLength={200}
                className={inputClass}
              />
            </Field>
            <Field label="Account number">
              <input
                type="text"
                value={draft.accountNumber ?? ''}
                onChange={(e) => setDraft({ ...draft, accountNumber: e.target.value })}
                maxLength={40}
                placeholder="C-1042"
                className={inputClass}
              />
            </Field>
            <Field label="Email">
              <input
                type="email"
                value={draft.email ?? ''}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                maxLength={200}
                className={inputClass}
              />
            </Field>
            <Field label="Phone">
              <input
                type="tel"
                value={draft.phone ?? ''}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                maxLength={40}
                className={inputClass}
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
                className={inputClass}
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={draft.taxExempt}
              onChange={(e) => setDraft({ ...draft, taxExempt: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300"
            />
            Tax-exempt (sales tax not charged)
          </label>

          {mode.type === 'edit' && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300"
              />
              Active
            </label>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!draft.displayName.trim() || mutation.isPending}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation.isPending ? 'Saving…' : mode.type === 'create' ? 'Save customer' : 'Save changes'}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>

          {mutation.isError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formatError(mutation.error)}
            </div>
          )}
        </form>
      )}

      {query.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : 'Failed to load customers.'}
        </p>
      )}
      {!query.isLoading && customers.length === 0 && (
        <EmptyState
          icon="users"
          title="No customers yet"
          description="Add a customer to start sending estimates and invoices. You can also bulk-import via the IIF importer in Accounting."
          action={{ label: 'New customer', onClick: startCreate }}
        />
      )}

      {customers.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Account #</th>
                <th className="px-4 py-2 text-left font-medium">Display name</th>
                <th className="px-4 py-2 text-left font-medium">Email</th>
                <th className="px-4 py-2 text-left font-medium">Phone</th>
                <th className="px-4 py-2 text-right font-medium">Terms</th>
                <th className="px-4 py-2 text-right font-medium">Opening balance</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {customers.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => setDetailId(c.id)}
                  className={
                    'cursor-pointer hover:bg-slate-50 ' + (c.isActive ? '' : 'opacity-60')
                  }
                >
                  <td className="px-4 py-2 font-mono text-slate-500">{c.accountNumber ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-900">
                    <div className="font-medium">
                      {c.displayName}
                      {!c.isActive && <span className="ml-2 text-xs text-slate-500">(inactive)</span>}
                    </div>
                    {c.companyName && <div className="text-xs text-slate-500">{c.companyName}</div>}
                  </td>
                  <td className="px-4 py-2 text-slate-700">{c.email ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-700">{c.phone ?? '—'}</td>
                  <td className="px-4 py-2 text-right text-slate-700">
                    {c.defaultTermsDays === null ? '—' : `Net ${c.defaultTermsDays}`}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">
                    {Number(c.openingBalance) === 0 ? '—' : c.openingBalance}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit(c);
                      }}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                    >
                      Edit
                    </button>
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

const inputClass =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900';

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
