import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface InvoiceListRow {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  status: 'open' | 'partial' | 'paid' | 'void';
  total: string;
  balanceDue: string;
  customerId: string;
  customerName: string;
  voidedAt: string | null;
}

interface Customer {
  id: string;
  displayName: string;
  defaultTermsDays: number | null;
  isActive: boolean;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  isActive: boolean;
}

interface LineDraft {
  accountId: string;
  description: string;
  quantity: string;
  unitPrice: string;
}

interface CreateBody {
  customerId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate?: string | undefined;
  memo?: string | undefined;
  lines: { accountId: string; description: string; quantity: string; unitPrice: string }[];
}

const today = () => new Date().toISOString().slice(0, 10);
const blankLine = (): LineDraft => ({ accountId: '', description: '', quantity: '1', unitPrice: '' });

const STATUS_COLOR: Record<InvoiceListRow['status'], string> = {
  open: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  partial: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  paid: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  void: 'bg-slate-100 text-slate-500 ring-slate-300',
};

function addCents(a: string, b: string): string {
  const toMicros = (s: string) => {
    if (!s) return 0n;
    const [whole = '0', frac = ''] = s.replace(/,/g, '').split('.');
    const padded = (frac + '0000').slice(0, 4);
    const sign = whole.startsWith('-') ? -1n : 1n;
    const wholeAbs = whole.replace(/^-/, '');
    return sign * (BigInt(wholeAbs || '0') * 10000n + BigInt(padded || '0'));
  };
  const sum = toMicros(a) + toMicros(b);
  const negative = sum < 0n;
  const abs = negative ? -sum : sum;
  const whole = abs / 10000n;
  const frac = abs % 10000n;
  return `${negative ? '-' : ''}${whole}.${String(frac).padStart(4, '0')}`;
}

function mulQtyPrice(qty: string, price: string): string {
  if (!qty || !price) return '0';
  const q = Number(qty);
  const p = Number(price);
  if (!Number.isFinite(q) || !Number.isFinite(p)) return '0';
  // Compute in micros to keep 4-dp parity with the server-side Money.
  const qMicros = BigInt(Math.round(q * 10000));
  const pMicros = BigInt(Math.round(p * 10000));
  // qMicros * pMicros / 10000 / 10000 → result in 4-dp.
  // Equivalent: (q * p) at full precision, then truncate to 4-dp.
  const product = qMicros * pMicros;
  const scaled = product / 10000n; // back to 4-dp
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / 10000n;
  const frac = abs % 10000n;
  return `${negative ? '-' : ''}${whole}.${String(frac).padStart(4, '0')}`;
}

function formatUsd(s: string): string {
  if (!s) return '$0.00';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

export function InvoicesList() {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'list' | 'new'>('list');

  const invoicesQuery = useQuery({
    queryKey: ['invoices', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ invoices: InvoiceListRow[] }>('/invoices', { companyId }),
  });

  const voidMutation = useMutation({
    mutationFn: async (invoiceId: string) =>
      api<{ id: string; voidedJournalEntryId: string }>(`/invoices/${invoiceId}/void`, {
        method: 'POST',
        companyId,
        body: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoices', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['trial-balance', companyId] });
    },
  });

  const list = invoicesQuery.data?.invoices ?? [];

  if (mode === 'new') {
    return (
      <NewInvoice
        onCancel={() => setMode('list')}
        onSaved={() => {
          setMode('list');
          void queryClient.invalidateQueries({ queryKey: ['invoices', companyId] });
          void queryClient.invalidateQueries({ queryKey: ['trial-balance', companyId] });
        }}
        invoiceCount={list.length}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Invoices</h2>
          <p className="text-sm text-slate-500">{list.length} on file</p>
        </div>
        <button
          type="button"
          onClick={() => setMode('new')}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          + New invoice
        </button>
      </div>

      {invoicesQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {invoicesQuery.isError && (
        <p className="text-sm text-rose-600">
          {invoicesQuery.error instanceof Error ? invoicesQuery.error.message : 'Failed to load invoices.'}
        </p>
      )}

      {!invoicesQuery.isLoading && list.length === 0 && (
        <p className="text-sm text-slate-500">No invoices yet.</p>
      )}

      {list.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Number</th>
                <th className="px-4 py-2 text-left font-medium">Date</th>
                <th className="px-4 py-2 text-left font-medium">Due</th>
                <th className="px-4 py-2 text-left font-medium">Customer</th>
                <th className="px-4 py-2 text-center font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 text-right font-medium">Balance</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {list.map((inv) => (
                <tr key={inv.id} className={inv.status === 'void' ? 'opacity-60' : ''}>
                  <td className="px-4 py-2 font-mono text-slate-900">{inv.invoiceNumber}</td>
                  <td className="px-4 py-2 text-slate-700">{inv.invoiceDate}</td>
                  <td className="px-4 py-2 text-slate-700">{inv.dueDate}</td>
                  <td className="px-4 py-2 text-slate-900">{inv.customerName}</td>
                  <td className="px-4 py-2 text-center">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_COLOR[inv.status]}`}
                    >
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(inv.total)}</td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">
                    {inv.status === 'void' ? '—' : formatUsd(inv.balanceDue)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {inv.status !== 'void' && (
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(`Void invoice ${inv.invoiceNumber}? A reversing journal entry will be posted.`)) {
                            voidMutation.mutate(inv.id);
                          }
                        }}
                        disabled={voidMutation.isPending}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
                      >
                        Void
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {voidMutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {formatError(voidMutation.error)}
        </div>
      )}
    </div>
  );
}

function NewInvoice({
  onCancel,
  onSaved,
  invoiceCount,
}: {
  onCancel: () => void;
  onSaved: () => void;
  invoiceCount: number;
}) {
  const { companyId } = useCurrentCompany();

  const customersQuery = useQuery({
    queryKey: ['customers', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ customers: Customer[] }>('/customers?active=true', { companyId }),
  });
  const accountsQuery = useQuery({
    queryKey: ['accounts', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ accounts: Account[] }>('/ledger/accounts?active=true', { companyId }),
  });

  const customers = useMemo(
    () => (customersQuery.data?.customers ?? []).filter((c) => c.isActive),
    [customersQuery.data],
  );
  // Default revenue accounts for line dropdowns; users can pick any account they want.
  const lineAccounts = useMemo(
    () =>
      (accountsQuery.data?.accounts ?? [])
        .filter((a) => a.isActive && (a.type === 'revenue' || a.type === 'expense'))
        .sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQuery.data],
  );

  const [draft, setDraft] = useState<{
    customerId: string;
    invoiceNumber: string;
    invoiceDate: string;
    dueDate: string;
    memo: string;
    lines: LineDraft[];
  }>(() => ({
    customerId: '',
    invoiceNumber: `INV-${1001 + invoiceCount}`,
    invoiceDate: today(),
    dueDate: '',
    memo: '',
    lines: [blankLine()],
  }));

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === draft.customerId),
    [customers, draft.customerId],
  );

  // If the user picks a customer with default terms, prefill due date — but
  // only when they haven't already typed a custom one.
  const computedDueDate = useMemo(() => {
    if (draft.dueDate) return draft.dueDate;
    if (!selectedCustomer?.defaultTermsDays || !draft.invoiceDate) return draft.invoiceDate;
    const d = new Date(draft.invoiceDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + selectedCustomer.defaultTermsDays);
    return d.toISOString().slice(0, 10);
  }, [draft.dueDate, draft.invoiceDate, selectedCustomer]);

  function updateLine(idx: number, patch: Partial<LineDraft>) {
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
    }));
  }
  function addLine() {
    setDraft((d) => ({ ...d, lines: [...d.lines, blankLine()] }));
  }
  function removeLine(idx: number) {
    setDraft((d) => ({
      ...d,
      lines: d.lines.length <= 1 ? d.lines : d.lines.filter((_, i) => i !== idx),
    }));
  }

  const computedLineAmounts = draft.lines.map((l) => mulQtyPrice(l.quantity, l.unitPrice));
  const subtotal = computedLineAmounts.reduce((acc, amt) => addCents(acc, amt), '0');

  const allLinesValid = draft.lines.every(
    (l, i) =>
      l.accountId &&
      l.description.trim() &&
      Number(computedLineAmounts[i] ?? '0') > 0,
  );
  const canSubmit =
    Boolean(draft.customerId) &&
    Boolean(draft.invoiceNumber.trim()) &&
    Number(subtotal) > 0 &&
    allLinesValid;

  const mutation = useMutation({
    mutationFn: async () => {
      const body: CreateBody = {
        customerId: draft.customerId,
        invoiceNumber: draft.invoiceNumber.trim(),
        invoiceDate: draft.invoiceDate,
        dueDate: draft.dueDate ? draft.dueDate : undefined,
        memo: draft.memo.trim() ? draft.memo.trim() : undefined,
        lines: draft.lines.map((l) => ({
          accountId: l.accountId,
          description: l.description.trim(),
          quantity: l.quantity || '1',
          unitPrice: l.unitPrice || '0',
        })),
      };
      return api<{ id: string; postedJournalEntryId: string; total: string }>('/invoices', {
        method: 'POST',
        companyId,
        body,
      });
    },
    onSuccess: () => onSaved(),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || mutation.isPending) return;
    mutation.mutate();
  }

  if (customersQuery.isLoading || accountsQuery.isLoading) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }
  if (customers.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">New Invoice</h2>
          <button type="button" onClick={onCancel} className="text-sm text-slate-600 hover:text-slate-900">
            Cancel
          </button>
        </div>
        <p className="text-sm text-slate-500">
          You need at least one active customer before creating an invoice. Add one in the Customers tab.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">New Invoice</h2>
        <button type="button" onClick={onCancel} className="text-sm text-slate-600 hover:text-slate-900">
          Cancel
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Customer" required>
          <select
            value={draft.customerId}
            onChange={(e) => setDraft({ ...draft, customerId: e.target.value })}
            required
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
          >
            <option value="">— select customer —</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Invoice #" required>
          <input
            type="text"
            value={draft.invoiceNumber}
            onChange={(e) => setDraft({ ...draft, invoiceNumber: e.target.value })}
            maxLength={40}
            required
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          />
        </Field>
        <Field label="Date" required>
          <input
            type="date"
            value={draft.invoiceDate}
            onChange={(e) => setDraft({ ...draft, invoiceDate: e.target.value })}
            required
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          />
        </Field>
        <Field label="Due date">
          <input
            type="date"
            value={draft.dueDate}
            onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
            placeholder={computedDueDate}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          />
          {!draft.dueDate && computedDueDate !== draft.invoiceDate && (
            <p className="text-xs text-slate-500">Defaulting to {computedDueDate} (customer's terms).</p>
          )}
        </Field>
        <Field label="Memo">
          <input
            type="text"
            value={draft.memo}
            onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
            maxLength={500}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 sm:col-span-2"
          />
        </Field>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-700">Lines</h3>
          <button
            type="button"
            onClick={addLine}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100"
          >
            + Add line
          </button>
        </div>
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Description</th>
                <th className="px-3 py-2 text-left font-medium">Account</th>
                <th className="px-3 py-2 text-right font-medium">Qty</th>
                <th className="px-3 py-2 text-right font-medium">Unit price</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {draft.lines.map((line, idx) => (
                <tr key={idx}>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={line.description}
                      onChange={(e) => updateLine(idx, { description: e.target.value })}
                      maxLength={500}
                      placeholder="Service rendered"
                      className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={line.accountId}
                      onChange={(e) => updateLine(idx, { accountId: e.target.value })}
                      required
                      className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
                    >
                      <option value="">— account —</option>
                      {lineAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) => updateLine(idx, { quantity: e.target.value.replace(/[^0-9.]/g, '') })}
                      className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-right font-mono text-sm focus:border-slate-900 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={line.unitPrice}
                      onChange={(e) => updateLine(idx, { unitPrice: e.target.value.replace(/[^0-9.]/g, '') })}
                      placeholder="0.00"
                      className="w-28 rounded-md border border-slate-300 px-2 py-1.5 text-right font-mono text-sm focus:border-slate-900 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-900">
                    {formatUsd(computedLineAmounts[idx] ?? '0')}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => removeLine(idx)}
                      disabled={draft.lines.length <= 1}
                      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-30"
                      aria-label="Remove line"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 text-sm font-medium">
              <tr>
                <td colSpan={4} className="px-3 py-2 text-right text-slate-600">
                  Subtotal
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-900">{formatUsd(subtotal)}</td>
                <td></td>
              </tr>
              <tr>
                <td colSpan={4} className="px-3 py-2 text-right text-slate-700">
                  Total
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-900">{formatUsd(subtotal)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!canSubmit || mutation.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation.isPending ? 'Posting…' : 'Save & post invoice'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>

      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {formatError(mutation.error)}
        </div>
      )}
    </form>
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
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? 'Error'}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : 'Operation failed.';
}
