import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ApiError, api, getApiBase, getIdToken } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type Status = 'draft' | 'sent' | 'accepted' | 'declined' | 'expired' | 'converted';

interface Customer {
  id: string;
  displayName: string;
  defaultTermsDays: number | null;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subtype: string;
  isActive: boolean;
}

interface TaxRate {
  id: string;
  name: string;
  ratePercent: string;
  isActive: boolean;
}

interface EstimateRow {
  id: string;
  estimateNumber: string;
  estimateDate: string;
  expirationDate: string | null;
  status: Status;
  customerId: string;
  customerName: string | null;
  memo: string | null;
  subtotal: string;
  taxAmount: string;
  total: string;
  convertedInvoiceId: string | null;
  convertedAt: string | null;
  createdAt: string;
}

interface EstimateLine {
  id: string;
  lineNumber: number;
  accountId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxable: boolean;
}

interface EstimateDetail {
  id: string;
  estimateNumber: string;
  estimateDate: string;
  expirationDate: string | null;
  termsDays: number | null;
  status: Status;
  customerId: string;
  customerName: string | null;
  memo: string | null;
  subtotal: string;
  taxRateId: string | null;
  taxAmount: string;
  total: string;
  convertedInvoiceId: string | null;
  convertedAt: string | null;
  createdAt: string;
  lines: EstimateLine[];
}

interface DraftLine {
  accountId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
}

interface Draft {
  customerId: string;
  estimateNumber: string;
  estimateDate: string;
  expirationDate: string;
  memo: string;
  taxRateId: string;
  lines: DraftLine[];
}

const STATUS_COLOR: Record<Status, string> = {
  draft: 'bg-slate-100 text-slate-700 ring-slate-300',
  sent: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  accepted: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  declined: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  expired: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  converted: 'bg-violet-50 text-violet-700 ring-violet-600/20',
};

const todayIso = () => new Date().toISOString().slice(0, 10);
const addDaysIso = (base: string, days: number) => {
  const d = new Date(base + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function formatUsd(s: string): string {
  if (!s) return '$0.00';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

function emptyLine(accountId: string): DraftLine {
  return { accountId, description: '', quantity: '1', unitPrice: '0', taxable: false };
}

export function EstimatesList() {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<Status | ''>('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const customersQ = useQuery({
    queryKey: ['customers', companyId, 'estimates-form'],
    enabled: Boolean(companyId),
    queryFn: () => api<{ customers: Customer[] }>('/customers', { companyId }),
  });
  const accountsQ = useQuery({
    queryKey: ['accounts', companyId, 'estimates-form'],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ accounts: Account[] }>('/ledger/accounts?active=true&type=revenue', { companyId }),
  });
  const taxRatesQ = useQuery({
    queryKey: ['tax-rates', companyId, 'estimates-form'],
    enabled: Boolean(companyId),
    queryFn: () => api<{ taxRates: TaxRate[] }>('/tax-rates', { companyId }),
  });
  const estimatesQ = useQuery({
    queryKey: ['estimates', companyId, statusFilter || 'all'],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ estimates: EstimateRow[] }>(
        statusFilter ? `/estimates?status=${statusFilter}` : '/estimates',
        { companyId },
      ),
  });

  if (detailId) {
    return <EstimateDetailView id={detailId} onBack={() => setDetailId(null)} />;
  }

  const customers = customersQ.data?.customers ?? [];
  const accounts = accountsQ.data?.accounts ?? [];
  const taxRates = taxRatesQ.data?.taxRates ?? [];
  const estimates = estimatesQ.data?.estimates ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Estimates</h2>
          <p className="text-sm text-slate-500">
            {estimates.length} on file. Quotes don't post to the ledger; once accepted, click
            "Convert to invoice" to create the corresponding A/R invoice in one shot.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as Status | '')}
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="accepted">Accepted</option>
            <option value="declined">Declined</option>
            <option value="expired">Expired</option>
            <option value="converted">Converted</option>
          </select>
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            {showForm ? 'Cancel' : '+ New estimate'}
          </button>
        </div>
      </div>

      {showForm && (
        <NewEstimateForm
          customers={customers}
          accounts={accounts}
          taxRates={taxRates}
          onCreated={(id) => {
            setShowForm(false);
            void queryClient.invalidateQueries({ queryKey: ['estimates', companyId] });
            setDetailId(id);
          }}
        />
      )}

      {estimatesQ.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {estimatesQ.isError && (
        <p className="text-sm text-rose-600">
          {estimatesQ.error instanceof Error ? estimatesQ.error.message : 'Failed to load.'}
        </p>
      )}
      {!estimatesQ.isLoading && estimates.length === 0 && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          No estimates yet. Click "+ New estimate" above.
        </p>
      )}

      {estimates.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Number</th>
                <th className="px-4 py-2 text-left font-medium">Date</th>
                <th className="px-4 py-2 text-left font-medium">Customer</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 text-left font-medium">Expires</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {estimates.map((e) => (
                <tr
                  key={e.id}
                  onClick={() => setDetailId(e.id)}
                  className="cursor-pointer hover:bg-slate-50"
                >
                  <td className="px-4 py-2 font-mono text-slate-700">{e.estimateNumber}</td>
                  <td className="px-4 py-2 text-slate-700">{e.estimateDate}</td>
                  <td className="px-4 py-2 text-slate-900">{e.customerName ?? '—'}</td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
                        STATUS_COLOR[e.status]
                      }
                    >
                      {e.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(e.total)}
                  </td>
                  <td className="px-4 py-2 text-slate-500">
                    {e.expirationDate ?? <span className="text-slate-400">—</span>}
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

function NewEstimateForm({
  customers,
  accounts,
  taxRates,
  onCreated,
}: {
  customers: Customer[];
  accounts: Account[];
  taxRates: TaxRate[];
  onCreated: (id: string) => void;
}) {
  const { companyId } = useCurrentCompany();
  const [draft, setDraft] = useState<Draft>(() => ({
    customerId: '',
    estimateNumber: defaultEstimateNumber(),
    estimateDate: todayIso(),
    expirationDate: addDaysIso(todayIso(), 30),
    memo: '',
    taxRateId: '',
    lines: [emptyLine(accounts[0]?.id ?? '')],
  }));

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        customerId: draft.customerId,
        estimateNumber: draft.estimateNumber.trim(),
        estimateDate: draft.estimateDate,
        lines: draft.lines.map((l) => ({
          accountId: l.accountId,
          description: l.description.trim(),
          quantity: l.quantity || '1',
          unitPrice: l.unitPrice || '0',
          taxable: l.taxable,
        })),
      };
      if (draft.expirationDate) body.expirationDate = draft.expirationDate;
      if (draft.memo.trim()) body.memo = draft.memo.trim();
      if (draft.taxRateId) body.taxRateId = draft.taxRateId;
      return api<{ id: string; total: string }>('/estimates', {
        method: 'POST',
        companyId,
        body,
      });
    },
    onSuccess: (data) => onCreated(data.id),
  });

  const subtotal = useMemo(() => {
    let sum = 0;
    for (const l of draft.lines) {
      const qty = Number(l.quantity || 0);
      const price = Number(l.unitPrice || 0);
      if (Number.isFinite(qty) && Number.isFinite(price)) sum += qty * price;
    }
    return sum;
  }, [draft.lines]);
  const taxRate = taxRates.find((t) => t.id === draft.taxRateId);
  const taxableSubtotal = useMemo(
    () =>
      draft.lines.reduce((acc, l) => {
        if (!l.taxable) return acc;
        const qty = Number(l.quantity || 0);
        const price = Number(l.unitPrice || 0);
        return acc + (Number.isFinite(qty) && Number.isFinite(price) ? qty * price : 0);
      }, 0),
    [draft.lines],
  );
  const taxAmount = taxRate ? (taxableSubtotal * Number(taxRate.ratePercent)) / 100 : 0;
  const total = subtotal + taxAmount;

  function setLine(idx: number, patch: Partial<DraftLine>) {
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
    }));
  }
  function addLine() {
    setDraft((d) => ({ ...d, lines: [...d.lines, emptyLine(accounts[0]?.id ?? '')] }));
  }
  function removeLine(idx: number) {
    setDraft((d) => ({ ...d, lines: d.lines.filter((_, i) => i !== idx) }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.customerId || !draft.estimateNumber.trim() || mutation.isPending) return;
    if (draft.lines.some((l) => !l.accountId || !l.description.trim())) return;
    mutation.mutate();
  }

  const canSubmit =
    draft.customerId &&
    draft.estimateNumber.trim() &&
    draft.lines.length > 0 &&
    draft.lines.every((l) => l.accountId && l.description.trim());

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-md border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-medium text-slate-700">New estimate</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Customer" required>
          <select
            value={draft.customerId}
            onChange={(e) => setDraft({ ...draft, customerId: e.target.value })}
            required
            className={inputClass}
          >
            <option value="">Choose…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Estimate #" required>
          <input
            type="text"
            value={draft.estimateNumber}
            onChange={(e) => setDraft({ ...draft, estimateNumber: e.target.value })}
            required
            maxLength={40}
            className={inputClass}
          />
        </Field>
        <Field label="Date" required>
          <input
            type="date"
            value={draft.estimateDate}
            onChange={(e) => setDraft({ ...draft, estimateDate: e.target.value })}
            required
            className={inputClass}
          />
        </Field>
        <Field label="Expires">
          <input
            type="date"
            value={draft.expirationDate}
            onChange={(e) => setDraft({ ...draft, expirationDate: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label="Tax rate">
          <select
            value={draft.taxRateId}
            onChange={(e) => setDraft({ ...draft, taxRateId: e.target.value })}
            className={inputClass}
          >
            <option value="">No tax</option>
            {taxRates
              .filter((t) => t.isActive)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({Number(t.ratePercent).toFixed(2)}%)
                </option>
              ))}
          </select>
        </Field>
        <Field label="Memo">
          <input
            type="text"
            value={draft.memo}
            onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
            maxLength={500}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium text-slate-700">Line items</h4>
          <button
            type="button"
            onClick={addLine}
            className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800"
          >
            + Add line
          </button>
        </div>
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Income account</th>
                <th className="px-3 py-2 text-left">Description</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Price</th>
                <th className="px-3 py-2 text-center">Tax</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {draft.lines.map((l, idx) => {
                const qty = Number(l.quantity || 0);
                const price = Number(l.unitPrice || 0);
                const amt = Number.isFinite(qty) && Number.isFinite(price) ? qty * price : 0;
                return (
                  <tr key={idx}>
                    <td className="px-3 py-2">
                      <select
                        value={l.accountId}
                        onChange={(e) => setLine(idx, { accountId: e.target.value })}
                        className={inputClass + ' min-w-[180px]'}
                      >
                        <option value="">Choose…</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.code} — {a.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="text"
                        value={l.description}
                        onChange={(e) => setLine(idx, { description: e.target.value })}
                        placeholder="Service description"
                        maxLength={500}
                        className={inputClass + ' min-w-[200px]'}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="0.0001"
                        min={0}
                        value={l.quantity}
                        onChange={(e) => setLine(idx, { quantity: e.target.value })}
                        className={inputClass + ' w-24 text-right font-mono'}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        step="0.0001"
                        min={0}
                        value={l.unitPrice}
                        onChange={(e) => setLine(idx, { unitPrice: e.target.value })}
                        className={inputClass + ' w-28 text-right font-mono'}
                      />
                    </td>
                    <td className="px-3 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={l.taxable}
                        onChange={(e) => setLine(idx, { taxable: e.target.checked })}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-700">
                      {formatUsd(amt.toFixed(4))}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {draft.lines.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeLine(idx)}
                          className="text-xs text-rose-600 hover:underline"
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-slate-50 text-sm">
              <tr>
                <td colSpan={5} className="px-3 py-2 text-right text-slate-600">
                  Subtotal
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-900">
                  {formatUsd(subtotal.toFixed(4))}
                </td>
                <td></td>
              </tr>
              {taxRate && (
                <tr>
                  <td colSpan={5} className="px-3 py-2 text-right text-slate-600">
                    Tax ({Number(taxRate.ratePercent).toFixed(2)}%)
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-900">
                    {formatUsd(taxAmount.toFixed(4))}
                  </td>
                  <td></td>
                </tr>
              )}
              <tr className="font-semibold">
                <td colSpan={5} className="px-3 py-2 text-right text-slate-900">
                  Total
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-900">
                  {formatUsd(total.toFixed(4))}
                </td>
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
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {mutation.isPending ? 'Creating…' : 'Save estimate'}
        </button>
      </div>

      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error)}
        </div>
      )}
    </form>
  );
}

function EstimateDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [convertOpen, setConvertOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const detailQ = useQuery({
    queryKey: ['estimate', id, companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<EstimateDetail>(`/estimates/${id}`, { companyId }),
  });

  const statusMutation = useMutation({
    mutationFn: async (status: 'draft' | 'sent' | 'accepted' | 'declined' | 'expired') =>
      api(`/estimates/${id}/status`, { method: 'POST', companyId, body: { status } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['estimate', id, companyId] });
      void queryClient.invalidateQueries({ queryKey: ['estimates', companyId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => api(`/estimates/${id}`, { method: 'DELETE', companyId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['estimates', companyId] });
      onBack();
    },
  });

  const data = detailQ.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          ← Back
        </button>
        {data && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                setDownloading(true);
                try {
                  const token = await getIdToken();
                  const res = await fetch(`${getApiBase()}/estimates/${id}.pdf`, {
                    headers: {
                      ...(token ? { Authorization: `Bearer ${token}` } : {}),
                      ...(companyId ? { 'x-kpbooks-company': companyId } : {}),
                    },
                  });
                  if (!res.ok) throw new Error(`HTTP ${res.status}`);
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `Estimate_${data.estimateNumber.replace(/[^A-Za-z0-9]+/g, '_')}.pdf`;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  URL.revokeObjectURL(url);
                } catch (err) {
                  alert(err instanceof Error ? err.message : 'PDF download failed.');
                } finally {
                  setDownloading(false);
                }
              }}
              disabled={downloading}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
            >
              {downloading ? 'Generating PDF…' : 'Download PDF'}
            </button>
            {data.status === 'draft' && (
              <button
                type="button"
                onClick={() => statusMutation.mutate('sent')}
                disabled={statusMutation.isPending}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
              >
                Mark as sent
              </button>
            )}
            {(data.status === 'draft' || data.status === 'sent') && (
              <>
                <button
                  type="button"
                  onClick={() => statusMutation.mutate('accepted')}
                  disabled={statusMutation.isPending}
                  className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm text-emerald-800 hover:bg-emerald-100"
                >
                  Mark accepted
                </button>
                <button
                  type="button"
                  onClick={() => statusMutation.mutate('declined')}
                  disabled={statusMutation.isPending}
                  className="rounded-md border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm text-rose-800 hover:bg-rose-100"
                >
                  Decline
                </button>
              </>
            )}
            {(data.status === 'accepted' ||
              data.status === 'sent' ||
              data.status === 'draft' ||
              data.status === 'expired') && (
              <button
                type="button"
                onClick={() => setConvertOpen(true)}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
              >
                Convert to invoice
              </button>
            )}
            {data.status !== 'converted' && (
              <button
                type="button"
                onClick={() => {
                  if (confirm(`Delete estimate ${data.estimateNumber}?`)) deleteMutation.mutate();
                }}
                className="rounded-md border border-rose-200 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50"
              >
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {detailQ.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {detailQ.isError && (
        <p className="text-sm text-rose-600">
          {detailQ.error instanceof Error ? detailQ.error.message : 'Failed to load.'}
        </p>
      )}

      {data && (
        <div className="space-y-4">
          <div className="rounded-md border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-wider text-slate-500">Estimate</div>
                <div className="text-2xl font-semibold tracking-tight text-slate-900">
                  {data.estimateNumber}
                </div>
                <div className="text-sm text-slate-600">
                  For {data.customerName ?? '—'} · {data.estimateDate}
                </div>
                {data.expirationDate && (
                  <div className="text-xs text-slate-500">Expires {data.expirationDate}</div>
                )}
                {data.memo && (
                  <div className="mt-2 text-sm italic text-slate-600">"{data.memo}"</div>
                )}
              </div>
              <div className="text-right">
                <span
                  className={
                    'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
                    STATUS_COLOR[data.status]
                  }
                >
                  {data.status}
                </span>
                {data.convertedInvoiceId && (
                  <div className="mt-1 text-xs text-slate-500">
                    Invoice ID: {data.convertedInvoiceId.slice(0, 8)}…
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">#</th>
                  <th className="px-4 py-2 text-left font-medium">Description</th>
                  <th className="px-4 py-2 text-right font-medium">Qty</th>
                  <th className="px-4 py-2 text-right font-medium">Price</th>
                  <th className="px-4 py-2 text-center font-medium">Tax</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {data.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-2 font-mono text-xs text-slate-500">{l.lineNumber}</td>
                    <td className="px-4 py-2 text-slate-900">{l.description}</td>
                    <td className="px-4 py-2 text-right font-mono text-slate-700">
                      {Number(l.quantity).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-700">
                      {formatUsd(l.unitPrice)}
                    </td>
                    <td className="px-4 py-2 text-center text-xs">
                      {l.taxable ? '✓' : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-900">
                      {formatUsd(l.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-slate-50">
                <tr>
                  <td colSpan={5} className="px-4 py-2 text-right text-slate-600">
                    Subtotal
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(data.subtotal)}
                  </td>
                </tr>
                {Number(data.taxAmount) > 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-2 text-right text-slate-600">
                      Tax
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-900">
                      {formatUsd(data.taxAmount)}
                    </td>
                  </tr>
                )}
                <tr className="font-semibold">
                  <td colSpan={5} className="px-4 py-2 text-right text-slate-900">
                    Total
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(data.total)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {(statusMutation.isError || deleteMutation.isError) && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formatError(statusMutation.error ?? deleteMutation.error)}
            </div>
          )}
        </div>
      )}

      {convertOpen && data && (
        <ConvertModal
          estimate={data}
          onClose={() => setConvertOpen(false)}
          onConverted={() => {
            setConvertOpen(false);
            void queryClient.invalidateQueries({ queryKey: ['estimate', id, companyId] });
            void queryClient.invalidateQueries({ queryKey: ['estimates', companyId] });
            void queryClient.invalidateQueries({ queryKey: ['invoices', companyId] });
          }}
        />
      )}
    </div>
  );
}

function ConvertModal({
  estimate,
  onClose,
  onConverted,
}: {
  estimate: EstimateDetail;
  onClose: () => void;
  onConverted: () => void;
}) {
  const { companyId } = useCurrentCompany();
  const [invoiceNumber, setInvoiceNumber] = useState(`INV-${estimate.estimateNumber}`);
  const [invoiceDate, setInvoiceDate] = useState(todayIso());
  const days = estimate.termsDays ?? 30;
  const [dueDate, setDueDate] = useState(addDaysIso(todayIso(), days));

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        invoiceNumber: invoiceNumber.trim(),
        invoiceDate,
      };
      if (dueDate) body.dueDate = dueDate;
      return api(`/estimates/${estimate.id}/convert`, { method: 'POST', companyId, body });
    },
    onSuccess: onConverted,
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
        <div>
          <h3 className="text-lg font-semibold tracking-tight text-slate-900">
            Convert to invoice
          </h3>
          <p className="text-xs text-slate-500">
            Creates a new posted A/R invoice (DR A/R, CR revenue per line) and locks this estimate
            from further edits. Estimate {estimate.estimateNumber} · {formatUsd(estimate.total)}
          </p>
        </div>

        <Field label="Invoice #" required>
          <input
            type="text"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            required
            maxLength={40}
            className={inputClass}
          />
        </Field>
        <Field label="Invoice date" required>
          <input
            type="date"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
            required
            className={inputClass}
          />
        </Field>
        <Field label="Due date">
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className={inputClass}
          />
        </Field>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={!invoiceNumber.trim() || mutation.isPending}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {mutation.isPending ? 'Converting…' : 'Convert'}
          </button>
          <button
            type="button"
            onClick={onClose}
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
      </div>
    </div>
  );
}

function defaultEstimateNumber(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const seed = Math.floor(Math.random() * 9000) + 1000;
  return `EST-${y}${m}${day}-${seed}`;
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
