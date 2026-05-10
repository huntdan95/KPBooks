import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type ItemType = 'service' | 'non_inventory';

interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subtype: string;
  isActive: boolean;
}

interface Item {
  id: string;
  name: string;
  sku: string | null;
  itemType: ItemType;
  salesDescription: string | null;
  salesPrice: string;
  salesAccountId: string | null;
  taxable: boolean;
  purchaseDescription: string | null;
  purchaseCost: string | null;
  purchaseAccountId: string | null;
  isActive: boolean;
  createdAt: string;
}

interface Draft {
  name: string;
  sku: string;
  itemType: ItemType;
  salesDescription: string;
  salesPrice: string;
  salesAccountId: string;
  taxable: boolean;
  purchaseDescription: string;
  purchaseCost: string;
  purchaseAccountId: string;
}

const emptyDraft = (): Draft => ({
  name: '',
  sku: '',
  itemType: 'service',
  salesDescription: '',
  salesPrice: '0',
  salesAccountId: '',
  taxable: false,
  purchaseDescription: '',
  purchaseCost: '',
  purchaseAccountId: '',
});

function rowToDraft(it: Item): Draft {
  return {
    name: it.name,
    sku: it.sku ?? '',
    itemType: it.itemType,
    salesDescription: it.salesDescription ?? '',
    salesPrice: it.salesPrice,
    salesAccountId: it.salesAccountId ?? '',
    taxable: it.taxable,
    purchaseDescription: it.purchaseDescription ?? '',
    purchaseCost: it.purchaseCost ?? '',
    purchaseAccountId: it.purchaseAccountId ?? '',
  };
}

type FormMode = null | { type: 'create' } | { type: 'edit'; id: string };

function formatUsd(s: string | null | undefined): string {
  if (!s) return '—';
  const n = Number(s);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function ItemsList() {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<FormMode>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [showInactive, setShowInactive] = useState(false);

  const itemsQ = useQuery({
    queryKey: ['items', companyId, showInactive],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ items: Item[] }>(showInactive ? '/items' : '/items?active=true', { companyId }),
  });

  const revenueAccountsQ = useQuery({
    queryKey: ['accounts', companyId, 'revenue'],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ accounts: Account[] }>('/ledger/accounts?active=true&type=revenue', {
        companyId,
      }),
  });

  const expenseAccountsQ = useQuery({
    queryKey: ['accounts', companyId, 'expense'],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ accounts: Account[] }>('/ledger/accounts?active=true&type=expense', {
        companyId,
      }),
  });

  const createMutation = useMutation({
    mutationFn: async (d: Draft) => api<Item>('/items', { method: 'POST', companyId, body: buildBody(d) }),
    onSuccess: () => {
      setMode(null);
      setDraft(emptyDraft());
      void queryClient.invalidateQueries({ queryKey: ['items', companyId] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      api<Item>(`/items/${id}`, { method: 'PATCH', companyId, body }),
    onSuccess: () => {
      setMode(null);
      setDraft(emptyDraft());
      void queryClient.invalidateQueries({ queryKey: ['items', companyId] });
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: async (id: string) => api(`/items/${id}`, { method: 'DELETE', companyId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['items', companyId] });
    },
  });

  function startCreate() {
    setMode({ type: 'create' });
    setDraft(emptyDraft());
  }
  function startEdit(it: Item) {
    setMode({ type: 'edit', id: it.id });
    setDraft(rowToDraft(it));
  }
  function cancel() {
    setMode(null);
    setDraft(emptyDraft());
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.name.trim()) return;
    if (!draft.salesAccountId && !draft.purchaseAccountId) return;
    if (mode?.type === 'create') createMutation.mutate(draft);
    else if (mode?.type === 'edit') updateMutation.mutate({ id: mode.id, body: buildBody(draft) });
  }

  const items = itemsQ.data?.items ?? [];
  const revenueAccounts = revenueAccountsQ.data?.accounts ?? [];
  const expenseAccounts = expenseAccountsQ.data?.accounts ?? [];
  const accountById = new Map<string, Account>();
  for (const a of revenueAccounts) accountById.set(a.id, a);
  for (const a of expenseAccounts) accountById.set(a.id, a);

  const canSubmit =
    draft.name.trim() && (draft.salesAccountId || draft.purchaseAccountId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            Items / services
          </h2>
          <p className="text-sm text-slate-500">
            {items.length} {showInactive ? 'total' : 'active'}. Items pre-fill the description,
            price, and GL account on invoice + bill lines so a 5-second line entry stays a
            5-second line entry.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300"
            />
            Show inactive
          </label>
          <button
            type="button"
            onClick={mode ? cancel : startCreate}
            className="whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            {mode ? 'Cancel' : '+ New item'}
          </button>
        </div>
      </div>

      {mode && (
        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-md border border-slate-200 bg-white p-4"
        >
          <h3 className="text-sm font-medium text-slate-700">
            {mode.type === 'create' ? 'New item' : 'Edit item'}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Name" required>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Site visit"
                maxLength={120}
                required
                autoFocus
                className={inputClass}
              />
            </Field>
            <Field label="SKU (optional)">
              <input
                type="text"
                value={draft.sku}
                onChange={(e) => setDraft({ ...draft, sku: e.target.value })}
                placeholder="SVC-001"
                maxLength={40}
                className={inputClass + ' font-mono'}
              />
            </Field>
            <Field label="Type">
              <select
                value={draft.itemType}
                onChange={(e) => setDraft({ ...draft, itemType: e.target.value as ItemType })}
                className={inputClass}
              >
                <option value="service">Service</option>
                <option value="non_inventory">Non-inventory</option>
              </select>
            </Field>
          </div>

          <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
            <legend className="px-1 text-xs font-medium uppercase tracking-wider text-slate-500">
              Sales side (used on invoices)
            </legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Income account">
                <select
                  value={draft.salesAccountId}
                  onChange={(e) => setDraft({ ...draft, salesAccountId: e.target.value })}
                  className={inputClass}
                >
                  <option value="">— not for sale —</option>
                  {revenueAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Default price">
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={draft.salesPrice}
                  onChange={(e) => setDraft({ ...draft, salesPrice: e.target.value })}
                  className={inputClass + ' font-mono'}
                />
              </Field>
              <label className="flex items-end gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={draft.taxable}
                  onChange={(e) => setDraft({ ...draft, taxable: e.target.checked })}
                  className="mb-2.5 h-4 w-4 rounded border-slate-300"
                />
                <span className="mb-1.5">Taxable by default</span>
              </label>
            </div>
            <Field label="Sales description">
              <input
                type="text"
                value={draft.salesDescription}
                onChange={(e) => setDraft({ ...draft, salesDescription: e.target.value })}
                placeholder="On-site service call (1-hour minimum)"
                maxLength={500}
                className={inputClass}
              />
            </Field>
          </fieldset>

          <fieldset className="space-y-3 rounded-md border border-slate-200 p-3">
            <legend className="px-1 text-xs font-medium uppercase tracking-wider text-slate-500">
              Purchase side (used on bills)
            </legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Expense account">
                <select
                  value={draft.purchaseAccountId}
                  onChange={(e) => setDraft({ ...draft, purchaseAccountId: e.target.value })}
                  className={inputClass}
                >
                  <option value="">— not purchased —</option>
                  {expenseAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Default cost">
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  value={draft.purchaseCost}
                  onChange={(e) => setDraft({ ...draft, purchaseCost: e.target.value })}
                  placeholder="optional"
                  className={inputClass + ' font-mono'}
                />
              </Field>
            </div>
            <Field label="Purchase description">
              <input
                type="text"
                value={draft.purchaseDescription}
                onChange={(e) => setDraft({ ...draft, purchaseDescription: e.target.value })}
                maxLength={500}
                className={inputClass}
              />
            </Field>
          </fieldset>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!canSubmit || createMutation.isPending || updateMutation.isPending}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {createMutation.isPending || updateMutation.isPending
                ? 'Saving…'
                : mode?.type === 'create'
                  ? 'Save item'
                  : 'Save changes'}
            </button>
            <p className="text-xs text-slate-500">
              At least one of <strong>Income account</strong> or <strong>Expense account</strong>{' '}
              is required so the item knows where to post.
            </p>
          </div>

          {(createMutation.isError || updateMutation.isError) && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formatError(createMutation.error ?? updateMutation.error)}
            </div>
          )}
        </form>
      )}

      {itemsQ.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {itemsQ.isError && (
        <p className="text-sm text-rose-600">
          {itemsQ.error instanceof Error ? itemsQ.error.message : 'Failed to load items.'}
        </p>
      )}
      {!itemsQ.isLoading && items.length === 0 && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          No items yet. Click "+ New item" above.
        </p>
      )}

      {items.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">SKU</th>
                <th className="px-4 py-2 text-left font-medium">Type</th>
                <th className="px-4 py-2 text-left font-medium">Income acct.</th>
                <th className="px-4 py-2 text-right font-medium">Sales price</th>
                <th className="px-4 py-2 text-left font-medium">Expense acct.</th>
                <th className="px-4 py-2 text-right font-medium">Cost</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {items.map((it) => {
                const sa = it.salesAccountId ? accountById.get(it.salesAccountId) : null;
                const pa = it.purchaseAccountId ? accountById.get(it.purchaseAccountId) : null;
                return (
                  <tr
                    key={it.id}
                    className={
                      'cursor-pointer hover:bg-slate-50 ' + (it.isActive ? '' : 'opacity-50')
                    }
                  >
                    <td className="px-4 py-2 text-slate-900">
                      <div className="font-medium">
                        {it.name}
                        {it.taxable && (
                          <span className="ml-2 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-700 ring-1 ring-amber-600/20">
                            tax
                          </span>
                        )}
                        {!it.isActive && (
                          <span className="ml-2 text-xs text-slate-500">(inactive)</span>
                        )}
                      </div>
                      {it.salesDescription && (
                        <div className="text-xs text-slate-500">{it.salesDescription}</div>
                      )}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-500">
                      {it.sku ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600">
                      {it.itemType === 'service' ? 'Service' : 'Non-inventory'}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600">
                      {sa ? `${sa.code} — ${sa.name}` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-900">
                      {sa ? formatUsd(it.salesPrice) : '—'}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600">
                      {pa ? `${pa.code} — ${pa.name}` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-700">
                      {pa ? formatUsd(it.purchaseCost) : '—'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => startEdit(it)}
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                        >
                          Edit
                        </button>
                        {it.isActive && (
                          <button
                            type="button"
                            onClick={() => {
                              if (
                                confirm(
                                  `Deactivate "${it.name}"? Existing invoices/bills that used it stay intact.`,
                                )
                              )
                                deactivateMutation.mutate(it.id);
                            }}
                            className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                          >
                            Deactivate
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function buildBody(d: Draft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: d.name.trim(),
    itemType: d.itemType,
    salesPrice: d.salesPrice || '0',
    taxable: d.taxable,
  };
  if (d.sku.trim()) body.sku = d.sku.trim();
  if (d.salesAccountId) body.salesAccountId = d.salesAccountId;
  if (d.salesDescription.trim()) body.salesDescription = d.salesDescription.trim();
  if (d.purchaseAccountId) body.purchaseAccountId = d.purchaseAccountId;
  if (d.purchaseDescription.trim()) body.purchaseDescription = d.purchaseDescription.trim();
  if (d.purchaseCost.trim()) body.purchaseCost = d.purchaseCost.trim();
  return body;
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? 'Error'}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : 'Failed.';
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
