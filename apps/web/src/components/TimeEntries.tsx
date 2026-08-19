import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface Vendor {
  id: string;
  displayName: string;
  defaultTermsDays: number | null;
  workerType?: string;
  payRate?: string | null;
  defaultExpenseAccountId?: string | null;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  isActive: boolean;
}

interface TimeEntryRow {
  id: string;
  vendorId: string;
  vendorName: string | null;
  entryDate: string;
  hours: string;
  rate: string;
  amount: string;
  description: string;
  project: string | null;
  accountId: string;
  accountCode: string | null;
  accountName: string | null;
  billedBillId: string | null;
  billedAt: string | null;
  notes: string | null;
  createdAt: string;
}

interface UnbilledSummaryRow {
  vendorId: string;
  vendorName: string;
  vendorEmail: string | null;
  entryCount: number;
  totalHours: string;
  totalAmount: string;
  earliestDate: string | null;
  latestDate: string | null;
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const addDaysIso = (base: string, days: number) => {
  const d = new Date(base + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function formatUsd(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '$0.00';
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatHours(s: string | number | null | undefined): string {
  if (s === null || s === undefined) return '0';
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n)) return '0';
  // 2 decimals usually enough; trim trailing zeros after the decimal
  return n
    .toFixed(2)
    .replace(/\.00$/, '')
    .replace(/0$/, '');
}

export function TimeEntries() {
  const { t } = useTranslation(['payroll', 'common']);
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [filterVendorId, setFilterVendorId] = useState<string>('');
  const [filterUnbilled, setFilterUnbilled] = useState<boolean>(true);
  const [filterFrom, setFilterFrom] = useState<string>('');
  const [filterTo, setFilterTo] = useState<string>('');
  const [showForm, setShowForm] = useState(false);
  const [buildBillFor, setBuildBillFor] = useState<UnbilledSummaryRow | null>(null);

  const vendorsQ = useQuery({
    queryKey: ['vendors', companyId, 'time-entries'],
    enabled: Boolean(companyId),
    queryFn: () => api<{ vendors: Vendor[] }>('/vendors?active=true', { companyId }),
  });

  const summaryQ = useQuery({
    queryKey: ['time-entries', companyId, 'unbilled-summary'],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ vendors: UnbilledSummaryRow[] }>('/time-entries/unbilled-summary', {
        companyId,
      }),
  });

  const queryParams = new URLSearchParams();
  if (filterVendorId) queryParams.set('vendorId', filterVendorId);
  if (filterFrom) queryParams.set('from', filterFrom);
  if (filterTo) queryParams.set('to', filterTo);
  if (filterUnbilled) queryParams.set('unbilledOnly', 'true');
  const qs = queryParams.toString();

  const entriesQ = useQuery({
    queryKey: ['time-entries', companyId, qs],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ entries: TimeEntryRow[] }>(`/time-entries${qs ? `?${qs}` : ''}`, { companyId }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) =>
      api(`/time-entries/${id}`, { method: 'DELETE', companyId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['time-entries', companyId] });
    },
  });

  const vendors = vendorsQ.data?.vendors ?? [];
  const summaryRows = summaryQ.data?.vendors ?? [];
  const entries = entriesQ.data?.entries ?? [];

  const totalUnbilledAmount = summaryRows.reduce(
    (acc, r) => acc + Number(r.totalAmount),
    0,
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            {t('timeEntries.title')}
          </h2>
          <p className="text-sm text-slate-500">
            {t('timeEntries.blurbBefore')} <strong>{t('timeEntries.buildBill')}</strong>{' '}
            {t('timeEntries.blurbAfter')}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          {showForm ? t('common:cancel') : t('timeEntries.logTimeAction')}
        </button>
      </div>

      {showForm && (
        <NewTimeEntryForm
          vendors={vendors}
          onCreated={() => {
            setShowForm(false);
            void queryClient.invalidateQueries({ queryKey: ['time-entries', companyId] });
          }}
        />
      )}

      {summaryRows.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              {t('timeEntries.unbilledByContractor')}
              <span className="ml-2 text-xs font-normal text-slate-500">
                {t('timeEntries.summaryMeta', {
                  count: summaryRows.length,
                  amount: formatUsd(totalUnbilledAmount.toFixed(4)),
                })}
              </span>
            </h3>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {summaryRows.map((r) => (
              <div
                key={r.vendorId}
                className="space-y-1.5 rounded-md border border-violet-200 bg-violet-50 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-slate-900">{r.vendorName}</div>
                    <div className="text-xs text-slate-500">
                      {t('timeEntries.entryMeta', {
                        count: r.entryCount,
                        hours: formatHours(r.totalHours),
                      })}
                      {r.earliestDate && r.latestDate && r.earliestDate !== r.latestDate && (
                        <>
                          {' '}
                          · {r.earliestDate} → {r.latestDate}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-lg font-semibold text-violet-900">
                      {formatUsd(r.totalAmount)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setBuildBillFor(r)}
                    className="rounded-md bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-800"
                  >
                    {t('timeEntries.buildBill')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setFilterVendorId(r.vendorId);
                      setFilterUnbilled(true);
                      setFilterFrom('');
                      setFilterTo('');
                    }}
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                  >
                    {t('timeEntries.viewEntries')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-white p-3">
        <Field label={t('timeEntries.fields.contractor')}>
          <select
            value={filterVendorId}
            onChange={(e) => setFilterVendorId(e.target.value)}
            className={inputClass + ' min-w-[180px]'}
          >
            <option value="">{t('timeEntries.all')}</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('common:from')}>
          <input
            type="date"
            value={filterFrom}
            onChange={(e) => setFilterFrom(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label={t('common:to')}>
          <input
            type="date"
            value={filterTo}
            onChange={(e) => setFilterTo(e.target.value)}
            className={inputClass}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={filterUnbilled}
            onChange={(e) => setFilterUnbilled(e.target.checked)}
            className="h-4 w-4 rounded border-slate-300"
          />
          {t('timeEntries.unbilledOnly')}
        </label>
      </div>

      {entriesQ.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {entriesQ.isError && (
        <p className="text-sm text-rose-600">
          {entriesQ.error instanceof Error ? entriesQ.error.message : t('failedToLoad')}
        </p>
      )}
      {!entriesQ.isLoading && entries.length === 0 && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          {filterUnbilled
            ? t('timeEntries.emptyUnbilled', { action: t('timeEntries.logTimeAction') })
            : t('timeEntries.empty')}
        </p>
      )}

      {entries.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">{t('common:date')}</th>
                <th className="px-4 py-2 text-left font-medium">
                  {t('timeEntries.fields.contractor')}
                </th>
                <th className="px-4 py-2 text-left font-medium">
                  {t('timeEntries.fields.description')}
                </th>
                <th className="px-4 py-2 text-left font-medium">{t('common:account')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('timeEntries.hrs')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('timeEntries.rate')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('common:amount')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('common:status')}</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {entries.map((e) => (
                <tr key={e.id} className={e.billedBillId ? 'opacity-60' : ''}>
                  <td className="px-4 py-2 text-slate-700">{e.entryDate}</td>
                  <td className="px-4 py-2 text-slate-900">{e.vendorName ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-700">
                    {e.description}
                    {e.project && (
                      <span className="ml-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-slate-600">
                        {e.project}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {e.accountCode && (
                      <span className="font-mono mr-1">{e.accountCode}</span>
                    )}
                    {e.accountName ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">
                    {formatHours(e.hours)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">
                    {formatUsd(e.rate)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(e.amount)}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {e.billedBillId ? (
                      <span className="rounded-md bg-emerald-50 px-2 py-0.5 text-emerald-700 ring-1 ring-emerald-600/20">
                        {t('timeEntries.status.billed')}
                      </span>
                    ) : (
                      <span className="rounded-md bg-amber-50 px-2 py-0.5 text-amber-700 ring-1 ring-amber-600/20">
                        {t('timeEntries.status.unbilled')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {!e.billedBillId && (
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(t('timeEntries.confirmDelete'))) deleteMutation.mutate(e.id);
                        }}
                        className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                      >
                        {t('common:delete')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {buildBillFor && (
        <BuildBillModal
          summary={buildBillFor}
          onClose={() => setBuildBillFor(null)}
          onBuilt={() => {
            setBuildBillFor(null);
            void queryClient.invalidateQueries({ queryKey: ['time-entries', companyId] });
            void queryClient.invalidateQueries({ queryKey: ['bills', companyId] });
          }}
        />
      )}
    </div>
  );
}

// --- New entry form ---------------------------------------------------------

interface NewDraft {
  vendorId: string;
  entryDate: string;
  hours: string;
  rate: string;
  description: string;
  project: string;
  accountId: string;
  notes: string;
}

const emptyDraft = (): NewDraft => ({
  vendorId: '',
  entryDate: todayIso(),
  hours: '1',
  rate: '',
  description: '',
  project: '',
  accountId: '',
  notes: '',
});

function NewTimeEntryForm({
  vendors,
  onCreated,
}: {
  vendors: Vendor[];
  onCreated: () => void;
}) {
  const { t } = useTranslation(['payroll', 'common']);
  const { companyId } = useCurrentCompany();
  const [draft, setDraft] = useState<NewDraft>(emptyDraft);

  const accountsQ = useQuery({
    queryKey: ['accounts', companyId, 'time-entries'],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ accounts: Account[] }>('/ledger/accounts?active=true&type=expense', { companyId }),
  });

  const vendorDetailsQ = useQuery({
    queryKey: ['vendor-detail', companyId, draft.vendorId],
    enabled: Boolean(companyId) && Boolean(draft.vendorId),
    queryFn: () => api<Vendor>(`/vendors/${draft.vendorId}`, { companyId }),
  });

  // Auto-fill rate + account from vendor when picked, if user hasn't typed in yet.
  const v = vendorDetailsQ.data;
  if (v) {
    if (!draft.rate && v.payRate) {
      setDraft((d) => ({ ...d, rate: v.payRate ?? '' }));
    }
    if (!draft.accountId && v.defaultExpenseAccountId) {
      setDraft((d) => ({ ...d, accountId: v.defaultExpenseAccountId ?? '' }));
    }
  }

  const accounts = accountsQ.data?.accounts ?? [];
  const amount = useMemo(() => {
    const h = Number(draft.hours || 0);
    const r = Number(draft.rate || 0);
    return Number.isFinite(h) && Number.isFinite(r) ? h * r : 0;
  }, [draft.hours, draft.rate]);

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        vendorId: draft.vendorId,
        entryDate: draft.entryDate,
        hours: draft.hours,
        description: draft.description.trim(),
      };
      if (draft.rate) body.rate = draft.rate;
      if (draft.project.trim()) body.project = draft.project.trim();
      if (draft.accountId) body.accountId = draft.accountId;
      if (draft.notes.trim()) body.notes = draft.notes.trim();
      return api<{ id: string; amount: string }>('/time-entries', {
        method: 'POST',
        companyId,
        body,
      });
    },
    onSuccess: () => onCreated(),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (
      !draft.vendorId ||
      !draft.entryDate ||
      !draft.hours ||
      !draft.description.trim() ||
      mutation.isPending
    ) {
      return;
    }
    mutation.mutate();
  }

  const canSubmit =
    draft.vendorId &&
    draft.entryDate &&
    Number(draft.hours) > 0 &&
    draft.description.trim();

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-medium text-slate-700">{t('timeEntries.logTime')}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Field label={t('timeEntries.fields.contractor')} required>
          <select
            value={draft.vendorId}
            onChange={(e) => setDraft({ ...draft, vendorId: e.target.value })}
            required
            className={inputClass}
          >
            <option value="">{t('timeEntries.choose')}</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('common:date')} required>
          <input
            type="date"
            value={draft.entryDate}
            onChange={(e) => setDraft({ ...draft, entryDate: e.target.value })}
            required
            className={inputClass}
          />
        </Field>
        <Field label={t('timeEntries.fields.hours')} required>
          <input
            type="number"
            step="0.01"
            min={0.01}
            value={draft.hours}
            onChange={(e) => setDraft({ ...draft, hours: e.target.value })}
            required
            className={inputClass + ' font-mono'}
          />
        </Field>
        <Field label={t('timeEntries.fields.rateHourly')}>
          <input
            type="number"
            step="0.01"
            min={0}
            value={draft.rate}
            onChange={(e) => setDraft({ ...draft, rate: e.target.value })}
            placeholder={v?.payRate ?? t('timeEntries.autoFromContractor')}
            className={inputClass + ' font-mono'}
          />
        </Field>
        <Field label={t('timeEntries.fields.description')} required>
          <input
            type="text"
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder={t('timeEntries.placeholders.description')}
            maxLength={500}
            required
            className={inputClass}
          />
        </Field>
        <Field label={t('timeEntries.fields.project')}>
          <input
            type="text"
            value={draft.project}
            onChange={(e) => setDraft({ ...draft, project: e.target.value })}
            placeholder={t('timeEntries.placeholders.project')}
            maxLength={120}
            className={inputClass}
          />
        </Field>
        <Field label={t('timeEntries.fields.expenseAccount')}>
          <select
            value={draft.accountId}
            onChange={(e) => setDraft({ ...draft, accountId: e.target.value })}
            className={inputClass}
          >
            <option value="">
              {v?.defaultExpenseAccountId
                ? t('timeEntries.useContractorDefault')
                : t('timeEntries.choose')}
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('timeEntries.fields.computedAmount')}>
          <input
            type="text"
            value={formatUsd(amount.toFixed(4))}
            readOnly
            className={inputClass + ' bg-slate-50 font-mono'}
          />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!canSubmit || mutation.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {mutation.isPending ? t('timeEntries.saving') : t('timeEntries.saveEntry')}
        </button>
        <p className="text-xs text-slate-500">
          {t('timeEntries.formHintBefore')}{' '}
          <strong>{t('timeEntries.status.unbilled')}</strong>{' '}
          {t('timeEntries.formHintAfter', { action: t('timeEntries.buildBill') })}
        </p>
      </div>

      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error, { error: t('shell:errors.label'), fallback: t('failed') })}
        </div>
      )}
    </form>
  );
}

// --- Build bill modal -------------------------------------------------------

function BuildBillModal({
  summary,
  onClose,
  onBuilt,
}: {
  summary: UnbilledSummaryRow;
  onClose: () => void;
  onBuilt: () => void;
}) {
  const { t } = useTranslation(['payroll', 'common']);
  const { companyId } = useCurrentCompany();
  const [billDate, setBillDate] = useState<string>(todayIso());
  const [dueDate, setDueDate] = useState<string>(addDaysIso(todayIso(), 30));
  const [billNumber, setBillNumber] = useState<string>('');
  const [memo, setMemo] = useState<string>('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const entriesQ = useQuery({
    queryKey: ['time-entries', companyId, 'build-bill', summary.vendorId],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ entries: TimeEntryRow[] }>(
        `/time-entries?vendorId=${summary.vendorId}&unbilledOnly=true`,
        { companyId },
      ),
  });

  const entries = entriesQ.data?.entries ?? [];
  const allIds = entries.map((e) => e.id);
  const allSelected = selectedIds.size === 0; // empty = all
  const includedIds = allSelected ? allIds : allIds.filter((id) => selectedIds.has(id));
  const includedTotal = entries
    .filter((e) => allSelected || selectedIds.has(e.id))
    .reduce((acc, e) => acc + Number(e.amount), 0);

  function toggleAll() {
    setSelectedIds((prev) => (prev.size === 0 ? new Set(allIds) : new Set()));
  }
  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        vendorId: summary.vendorId,
        billDate,
      };
      if (dueDate) body.dueDate = dueDate;
      if (billNumber.trim()) body.billNumber = billNumber.trim();
      if (memo.trim()) body.memo = memo.trim();
      if (!allSelected && includedIds.length > 0) body.entryIds = includedIds;
      return api<{ billId: string; billNumber: string; total: string; entryCount: number }>(
        '/time-entries/build-bill',
        { method: 'POST', companyId, body },
      );
    },
    onSuccess: () => onBuilt(),
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="my-8 w-full max-w-3xl space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">
              {t('timeEntries.buildBillTitle')}
            </h2>
            <p className="text-xs text-slate-500">
              {t('timeEntries.buildBillBlurbBefore')} <strong>{summary.vendorName}</strong>
              {t('timeEntries.buildBillBlurbAfter')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common:close')}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label={t('timeEntries.fields.billDate')} required>
            <input
              type="date"
              value={billDate}
              onChange={(e) => setBillDate(e.target.value)}
              required
              className={inputClass}
            />
          </Field>
          <Field label={t('timeEntries.fields.dueDate')}>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label={t('timeEntries.fields.billNumber')}>
            <input
              type="text"
              value={billNumber}
              onChange={(e) => setBillNumber(e.target.value)}
              placeholder={t('timeEntries.placeholders.billNumber')}
              maxLength={40}
              className={inputClass + ' font-mono'}
            />
          </Field>
        </div>

        <Field label={t('timeEntries.fields.memo')}>
          <input
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            maxLength={500}
            placeholder={t('timeEntries.placeholders.memo', {
              from: summary.earliestDate,
              to: summary.latestDate,
            })}
            className={inputClass}
          />
        </Field>

        {entriesQ.isLoading && (
          <p className="text-sm text-slate-500">{t('timeEntries.loadingEntries')}</p>
        )}

        {entries.length > 0 && (
          <div className="overflow-hidden rounded-md border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="w-8 px-3 py-2 text-left">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="h-4 w-4 rounded border-slate-300"
                      title={
                        allSelected
                          ? t('timeEntries.includingAll')
                          : t('timeEntries.includingSelected')
                      }
                    />
                  </th>
                  <th className="px-3 py-2 text-left font-medium">{t('common:date')}</th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('timeEntries.fields.description')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">{t('timeEntries.hrs')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('timeEntries.rate')}</th>
                  <th className="px-3 py-2 text-right font-medium">{t('common:amount')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {entries.map((e) => {
                  const checked = allSelected || selectedIds.has(e.id);
                  return (
                    <tr key={e.id}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleOne(e.id)}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                      </td>
                      <td className="px-3 py-2 text-slate-700">{e.entryDate}</td>
                      <td className="px-3 py-2 text-slate-900">
                        {e.description}
                        {e.project && (
                          <span className="ml-1.5 text-xs text-slate-500">[{e.project}]</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-700">
                        {formatHours(e.hours)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-700">
                        {formatUsd(e.rate)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-900">
                        {formatUsd(e.amount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-slate-50">
                <tr className="font-semibold">
                  <td colSpan={5} className="px-3 py-2 text-right text-slate-900">
                    {t('timeEntries.billTotal')}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-900">
                    {formatUsd(includedTotal.toFixed(4))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            {t('common:cancel')}
          </button>
          <button
            type="button"
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || includedIds.length === 0}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {mutation.isPending
              ? t('timeEntries.postingBill')
              : t('timeEntries.postBill', { count: includedIds.length })}
          </button>
        </div>

        {mutation.isError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {formatError(mutation.error, { error: t('shell:errors.label'), fallback: t('failed') })}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Bits -------------------------------------------------------------------

function formatError(err: unknown, labels: { error: string; fallback: string }): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? labels.error}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : labels.fallback;
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
