import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type Kind = 'invoice' | 'bill';
type Frequency = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'annually';

interface PayloadLine {
  accountId: string;
  description: string;
  quantity: string | number;
  unitPrice: string | number;
  taxable?: boolean;
}

interface InvoicePayload {
  customerId: string;
  termsDays?: number;
  memo?: string;
  taxRateId?: string;
  numberPrefix?: string;
  lines: PayloadLine[];
}

interface BillPayload {
  vendorId: string;
  termsDays?: number;
  memo?: string;
  numberPrefix?: string;
  lines: PayloadLine[];
}

interface Template {
  id: string;
  companyId: string;
  kind: Kind;
  name: string;
  frequency: Frequency;
  dayOfMonth: number | null;
  dayOfWeek: number | null;
  startDate: string;
  endDate: string | null;
  nextRunDate: string;
  lastRunDate: string | null;
  lastRunDocumentId: string | null;
  isActive: boolean;
  payload: InvoicePayload | BillPayload;
  runCount: number;
  createdAt: string;
}

interface Customer {
  id: string;
  displayName: string;
  defaultTermsDays: number | null;
}
interface Vendor {
  id: string;
  displayName: string;
  defaultTermsDays: number | null;
}
interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  isActive: boolean;
}
interface TaxRate {
  id: string;
  name: string;
  ratePercent: string;
  isActive: boolean;
}

const FREQ_LABEL: Record<Frequency, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annually: 'Annually',
};

const DOW_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const todayIso = () => new Date().toISOString().slice(0, 10);

function formatUsd(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === '') return '$0.00';
  const str = typeof s === 'number' ? s.toString() : s;
  const [whole = '0', frac = '0000'] = str.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

function describeSchedule(t: Pick<Template, 'frequency' | 'dayOfMonth' | 'dayOfWeek'>): string {
  switch (t.frequency) {
    case 'weekly':
      return `Weekly on ${DOW_LABEL[t.dayOfWeek ?? 1]}`;
    case 'biweekly':
      return `Every 2 weeks on ${DOW_LABEL[t.dayOfWeek ?? 1]}`;
    case 'monthly':
      return t.dayOfMonth === 31
        ? 'Monthly on the last day'
        : `Monthly on day ${t.dayOfMonth ?? 1}`;
    case 'quarterly':
      return t.dayOfMonth === 31
        ? 'Quarterly on the last day'
        : `Quarterly on day ${t.dayOfMonth ?? 1}`;
    case 'annually':
      return t.dayOfMonth === 31
        ? 'Annually on the last day'
        : `Annually on day ${t.dayOfMonth ?? 1}`;
  }
}

export function Recurring() {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Kind | 'all'>('all');
  const [showForm, setShowForm] = useState(false);

  const templatesQ = useQuery({
    queryKey: ['recurring', companyId, tab],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ templates: Template[] }>(
        tab === 'all' ? '/recurring' : `/recurring?kind=${tab}`,
        { companyId },
      ),
  });

  const runDueMutation = useMutation({
    mutationFn: async () =>
      api<{
        ran: Array<{ documentNumber: string; documentKind: Kind; documentDate: string }>;
        failed: Array<{ name: string; error: string }>;
      }>('/recurring/run-all-due', { method: 'POST', companyId, body: {} }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recurring', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['invoices', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['bills', companyId] });
    },
  });

  const runOneMutation = useMutation({
    mutationFn: async (id: string) =>
      api<{ documentNumber: string; documentDate: string }>(`/recurring/${id}/run`, {
        method: 'POST',
        companyId,
        body: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recurring', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['invoices', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['bills', companyId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) =>
      api(`/recurring/${id}`, { method: 'DELETE', companyId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recurring', companyId] });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) =>
      api(`/recurring/${id}`, { method: 'PATCH', companyId, body: { isActive } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recurring', companyId] });
    },
  });

  const templates = templatesQ.data?.templates ?? [];
  const today = todayIso();
  const dueCount = templates.filter(
    (t) => t.isActive && t.nextRunDate <= today && (!t.endDate || t.endDate >= today),
  ).length;

  const counts = {
    all: templates.length,
    invoice: templates.filter((t) => t.kind === 'invoice').length,
    bill: templates.filter((t) => t.kind === 'bill').length,
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            Recurring transactions
          </h2>
          <p className="text-sm text-slate-500">
            Templates for invoices and bills that fire on a schedule. Each fire posts a real
            invoice/bill through the same A/R / A/P pipeline as a one-off doc — same validation,
            same ledger writes. Click "Run all due" to fire everything that's caught up to today.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => runDueMutation.mutate()}
            disabled={dueCount === 0 || runDueMutation.isPending}
            className="whitespace-nowrap rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-50"
            title={
              dueCount === 0
                ? 'Nothing is due today'
                : `${dueCount} template(s) due as of today`
            }
          >
            {runDueMutation.isPending
              ? 'Running…'
              : `Run all due${dueCount > 0 ? ` (${dueCount})` : ''}`}
          </button>
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            {showForm ? 'Cancel' : '+ New template'}
          </button>
        </div>
      </div>

      {runDueMutation.data && (
        <div
          className={
            'rounded-md border px-3 py-2 text-sm ' +
            (runDueMutation.data.failed.length === 0
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-amber-200 bg-amber-50 text-amber-800')
          }
        >
          Posted {runDueMutation.data.ran.length} new doc(s)
          {runDueMutation.data.failed.length > 0
            ? `, ${runDueMutation.data.failed.length} failed`
            : ''}
          .
          {runDueMutation.data.failed.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs">
              {runDueMutation.data.failed.map((f, i) => (
                <li key={i}>
                  <strong>{f.name}:</strong> {f.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showForm && (
        <NewTemplateForm
          onCreated={() => {
            setShowForm(false);
            void queryClient.invalidateQueries({ queryKey: ['recurring', companyId] });
          }}
        />
      )}

      <div className="flex gap-1 border-b border-slate-200">
        {(
          [
            { id: 'all', label: 'All', count: counts.all },
            { id: 'invoice', label: 'Invoices', count: counts.invoice },
            { id: 'bill', label: 'Bills', count: counts.bill },
          ] as const
        ).map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={
                'border-b-2 px-3 py-2 text-sm transition-colors -mb-px ' +
                (active
                  ? 'border-slate-900 font-medium text-slate-900'
                  : 'border-transparent text-slate-500 hover:text-slate-800')
              }
            >
              {t.label}
              <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs font-mono text-slate-600">
                {t.count}
              </span>
            </button>
          );
        })}
      </div>

      {templatesQ.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {templatesQ.isError && (
        <p className="text-sm text-rose-600">
          {templatesQ.error instanceof Error
            ? templatesQ.error.message
            : 'Failed to load templates.'}
        </p>
      )}
      {!templatesQ.isLoading && templates.length === 0 && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          No templates yet. Click "+ New template" above to set one up.
        </p>
      )}

      {templates.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Kind</th>
                <th className="px-4 py-2 text-left font-medium">Schedule</th>
                <th className="px-4 py-2 text-left font-medium">Next run</th>
                <th className="px-4 py-2 text-left font-medium">Last run</th>
                <th className="px-4 py-2 text-right font-medium">Fires</th>
                <th className="px-4 py-2 text-center font-medium">Active</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {templates.map((t) => {
                const due =
                  t.isActive && t.nextRunDate <= today && (!t.endDate || t.endDate >= today);
                const ended = t.endDate && t.endDate < today;
                return (
                  <tr key={t.id} className={t.isActive ? '' : 'opacity-60'}>
                    <td className="px-4 py-2 text-slate-900">
                      <div className="font-medium">{t.name}</div>
                      <div className="text-xs text-slate-500">
                        {t.kind === 'invoice'
                          ? `${(t.payload as InvoicePayload).lines?.length ?? 0} line(s) · ${
                              (t.payload as InvoicePayload).lines
                                ?.reduce(
                                  (acc, l) =>
                                    acc + Number(l.quantity || 0) * Number(l.unitPrice || 0),
                                  0,
                                )
                                ?.toFixed(2) ?? '0.00'
                            }`
                          : `${(t.payload as BillPayload).lines?.length ?? 0} line(s) · ${
                              (t.payload as BillPayload).lines
                                ?.reduce(
                                  (acc, l) =>
                                    acc + Number(l.quantity || 0) * Number(l.unitPrice || 0),
                                  0,
                                )
                                ?.toFixed(2) ?? '0.00'
                            }`}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={
                          'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
                          (t.kind === 'invoice'
                            ? 'bg-sky-50 text-sky-700 ring-sky-600/20'
                            : 'bg-amber-50 text-amber-700 ring-amber-600/20')
                        }
                      >
                        {t.kind === 'invoice' ? 'Invoice' : 'Bill'}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600">{describeSchedule(t)}</td>
                    <td className="px-4 py-2 text-slate-700">
                      {ended ? (
                        <span className="text-xs text-slate-400">Ended {t.endDate}</span>
                      ) : (
                        <div className="flex items-center gap-1">
                          {t.nextRunDate}
                          {due && (
                            <span className="rounded-md bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-700 ring-1 ring-emerald-600/20">
                              due
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {t.lastRunDate ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-700">{t.runCount}</td>
                    <td className="px-4 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={t.isActive}
                        onChange={(e) =>
                          toggleMutation.mutate({ id: t.id, isActive: e.target.checked })
                        }
                        className="h-4 w-4 rounded border-slate-300"
                      />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => runOneMutation.mutate(t.id)}
                          disabled={!t.isActive || runOneMutation.isPending || Boolean(ended)}
                          className="rounded-md border border-slate-300 bg-slate-900 px-2 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                          title={
                            !t.isActive
                              ? 'Activate first'
                              : ended
                                ? 'Past end date'
                                : 'Fire one occurrence now'
                          }
                        >
                          Run now
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(`Delete template "${t.name}"?`)) deleteMutation.mutate(t.id);
                          }}
                          className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {(runOneMutation.isError || deleteMutation.isError || toggleMutation.isError) && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(
            runOneMutation.error ?? deleteMutation.error ?? toggleMutation.error,
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------- New template form ------------------------------

interface DraftLine {
  accountId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
}

interface Draft {
  kind: Kind;
  name: string;
  frequency: Frequency;
  dayOfMonth: string;
  dayOfWeek: string;
  startDate: string;
  endDate: string;
  customerId: string;
  vendorId: string;
  taxRateId: string;
  numberPrefix: string;
  memo: string;
  lines: DraftLine[];
}

const emptyDraft = (): Draft => ({
  kind: 'invoice',
  name: '',
  frequency: 'monthly',
  dayOfMonth: '1',
  dayOfWeek: '1',
  startDate: todayIso(),
  endDate: '',
  customerId: '',
  vendorId: '',
  taxRateId: '',
  numberPrefix: 'REC',
  memo: '',
  lines: [{ accountId: '', description: '', quantity: '1', unitPrice: '0', taxable: false }],
});

function NewTemplateForm({ onCreated }: { onCreated: () => void }) {
  const { companyId } = useCurrentCompany();
  const [draft, setDraft] = useState<Draft>(emptyDraft);

  const customersQ = useQuery({
    queryKey: ['customers', companyId, 'recurring'],
    enabled: Boolean(companyId),
    queryFn: () => api<{ customers: Customer[] }>('/customers', { companyId }),
  });
  const vendorsQ = useQuery({
    queryKey: ['vendors', companyId, 'recurring'],
    enabled: Boolean(companyId),
    queryFn: () => api<{ vendors: Vendor[] }>('/vendors', { companyId }),
  });
  const accountsQ = useQuery({
    queryKey: ['accounts', companyId, 'recurring', draft.kind],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ accounts: Account[] }>(
        `/ledger/accounts?active=true&type=${draft.kind === 'invoice' ? 'revenue' : 'expense'}`,
        { companyId },
      ),
  });
  const taxRatesQ = useQuery({
    queryKey: ['tax-rates', companyId, 'recurring'],
    enabled: Boolean(companyId) && draft.kind === 'invoice',
    queryFn: () => api<{ taxRates: TaxRate[] }>('/tax-rates', { companyId }),
  });

  const customers = customersQ.data?.customers ?? [];
  const vendors = vendorsQ.data?.vendors ?? [];
  const accounts = accountsQ.data?.accounts ?? [];
  const taxRates = taxRatesQ.data?.taxRates ?? [];

  const subtotal = useMemo(() => {
    let sum = 0;
    for (const l of draft.lines) {
      const q = Number(l.quantity || 0);
      const p = Number(l.unitPrice || 0);
      if (Number.isFinite(q) && Number.isFinite(p)) sum += q * p;
    }
    return sum;
  }, [draft.lines]);

  const mutation = useMutation({
    mutationFn: async () => {
      const lines = draft.lines.map((l) => ({
        accountId: l.accountId,
        description: l.description.trim(),
        quantity: l.quantity || '1',
        unitPrice: l.unitPrice || '0',
        taxable: l.taxable,
      }));
      const payload: Record<string, unknown> =
        draft.kind === 'invoice'
          ? {
              customerId: draft.customerId,
              lines,
              ...(draft.taxRateId ? { taxRateId: draft.taxRateId } : {}),
              ...(draft.memo.trim() ? { memo: draft.memo.trim() } : {}),
              ...(draft.numberPrefix.trim() ? { numberPrefix: draft.numberPrefix.trim() } : {}),
            }
          : {
              vendorId: draft.vendorId,
              lines,
              ...(draft.memo.trim() ? { memo: draft.memo.trim() } : {}),
              ...(draft.numberPrefix.trim() ? { numberPrefix: draft.numberPrefix.trim() } : {}),
            };
      const body: Record<string, unknown> = {
        kind: draft.kind,
        name: draft.name.trim(),
        frequency: draft.frequency,
        startDate: draft.startDate,
        payload,
      };
      if (draft.frequency === 'weekly' || draft.frequency === 'biweekly') {
        body.dayOfWeek = Number(draft.dayOfWeek);
      } else {
        body.dayOfMonth = Number(draft.dayOfMonth);
      }
      if (draft.endDate) body.endDate = draft.endDate;
      return api<{ id: string; nextRunDate: string }>('/recurring', {
        method: 'POST',
        companyId,
        body,
      });
    },
    onSuccess: onCreated,
  });

  function setLine(idx: number, patch: Partial<DraftLine>) {
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
    }));
  }
  function addLine() {
    setDraft((d) => ({
      ...d,
      lines: [
        ...d.lines,
        { accountId: '', description: '', quantity: '1', unitPrice: '0', taxable: false },
      ],
    }));
  }
  function removeLine(idx: number) {
    setDraft((d) => ({ ...d, lines: d.lines.filter((_, i) => i !== idx) }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.name.trim()) return;
    if (draft.kind === 'invoice' && !draft.customerId) return;
    if (draft.kind === 'bill' && !draft.vendorId) return;
    if (draft.lines.some((l) => !l.accountId || !l.description.trim())) return;
    mutation.mutate();
  }

  const canSubmit =
    draft.name.trim() &&
    (draft.kind === 'invoice' ? draft.customerId : draft.vendorId) &&
    draft.lines.length > 0 &&
    draft.lines.every((l) => l.accountId && l.description.trim());

  const periodicHint =
    draft.frequency === 'monthly' ||
    draft.frequency === 'quarterly' ||
    draft.frequency === 'annually';

  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-md border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-medium text-slate-700">New recurring template</h3>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Kind" required>
          <select
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind })}
            className={inputClass}
          >
            <option value="invoice">Invoice (A/R)</option>
            <option value="bill">Bill (A/P)</option>
          </select>
        </Field>
        <Field label="Template name" required>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder={
              draft.kind === 'invoice' ? 'Acme monthly retainer' : 'Office rent — landlord'
            }
            maxLength={120}
            required
            autoFocus
            className={inputClass}
          />
        </Field>
        {draft.kind === 'invoice' ? (
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
        ) : (
          <Field label="Vendor" required>
            <select
              value={draft.vendorId}
              onChange={(e) => setDraft({ ...draft, vendorId: e.target.value })}
              required
              className={inputClass}
            >
              <option value="">Choose…</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Frequency" required>
          <select
            value={draft.frequency}
            onChange={(e) => setDraft({ ...draft, frequency: e.target.value as Frequency })}
            className={inputClass}
          >
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every 2 weeks</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="annually">Annually</option>
          </select>
        </Field>
        {periodicHint ? (
          <Field label="Day of month" required>
            <select
              value={draft.dayOfMonth}
              onChange={(e) => setDraft({ ...draft, dayOfMonth: e.target.value })}
              className={inputClass}
            >
              {Array.from({ length: 31 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n === 31 ? '31 (last day of month)' : `${n}`}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label="Day of week" required>
            <select
              value={draft.dayOfWeek}
              onChange={(e) => setDraft({ ...draft, dayOfWeek: e.target.value })}
              className={inputClass}
            >
              {DOW_LABEL.map((d, i) => (
                <option key={i} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Start date" required>
          <input
            type="date"
            value={draft.startDate}
            onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
            required
            className={inputClass}
          />
        </Field>
        <Field label="End date (optional)">
          <input
            type="date"
            value={draft.endDate}
            onChange={(e) => setDraft({ ...draft, endDate: e.target.value })}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Number prefix">
          <input
            type="text"
            value={draft.numberPrefix}
            onChange={(e) => setDraft({ ...draft, numberPrefix: e.target.value })}
            maxLength={10}
            placeholder="REC"
            className={inputClass + ' font-mono'}
          />
        </Field>
        {draft.kind === 'invoice' && (
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
        )}
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

      {/* Lines */}
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
                <th className="px-3 py-2 text-left">
                  {draft.kind === 'invoice' ? 'Income account' : 'Expense account'}
                </th>
                <th className="px-3 py-2 text-left">Description</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2 text-right">Price</th>
                {draft.kind === 'invoice' && (
                  <th className="px-3 py-2 text-center">Tax</th>
                )}
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {draft.lines.map((l, idx) => {
                const q = Number(l.quantity || 0);
                const p = Number(l.unitPrice || 0);
                const amt = Number.isFinite(q) && Number.isFinite(p) ? q * p : 0;
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
                    {draft.kind === 'invoice' && (
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={l.taxable}
                          onChange={(e) => setLine(idx, { taxable: e.target.checked })}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                      </td>
                    )}
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
            <tfoot className="bg-slate-50">
              <tr className="font-medium">
                <td colSpan={draft.kind === 'invoice' ? 5 : 4} className="px-3 py-2 text-right text-slate-700">
                  Subtotal
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-900">
                  {formatUsd(subtotal.toFixed(4))}
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
          {mutation.isPending ? 'Creating…' : 'Save template'}
        </button>
        <p className="text-xs text-slate-500">
          The first run-date is computed from your start date + schedule (e.g. monthly day=15
          starting 2026-05-08 → first run 2026-05-15).
        </p>
      </div>

      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error)}
        </div>
      )}
    </form>
  );
}

// --- Bits -----------------------------------------------------------------

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
