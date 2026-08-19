import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('sales');
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
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            {t('estimates.title')}
          </h2>
          <p className="text-sm text-slate-500">
            {t('estimates.blurb', { count: estimates.length })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as Status | '')}
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
          >
            <option value="">{t('estimates.filter.all')}</option>
            <option value="draft">{t('estimates.filter.draft')}</option>
            <option value="sent">{t('estimates.filter.sent')}</option>
            <option value="accepted">{t('estimates.filter.accepted')}</option>
            <option value="declined">{t('estimates.filter.declined')}</option>
            <option value="expired">{t('estimates.filter.expired')}</option>
            <option value="converted">{t('estimates.filter.converted')}</option>
          </select>
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            {showForm ? t('cancel', { ns: 'common' }) : t('estimates.newButton')}
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

      {estimatesQ.isLoading && (
        <p className="text-sm text-slate-500">{t('loading', { ns: 'common' })}</p>
      )}
      {estimatesQ.isError && (
        <p className="text-sm text-rose-600">
          {estimatesQ.error instanceof Error ? estimatesQ.error.message : t('shared.failedToLoad')}
        </p>
      )}
      {!estimatesQ.isLoading && estimates.length === 0 && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          {t('estimates.emptyHint')}
        </p>
      )}

      {estimates.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">{t('shared.number')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('date', { ns: 'common' })}</th>
                <th className="px-4 py-2 text-left font-medium">{t('shared.customer')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('status', { ns: 'common' })}</th>
                <th className="px-4 py-2 text-right font-medium">{t('total', { ns: 'common' })}</th>
                <th className="px-4 py-2 text-left font-medium">{t('estimates.table.expires')}</th>
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
                      {t(`estimates.status.${e.status}`)}
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
  const { t } = useTranslation('sales');
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
  const taxRate = taxRates.find((r) => r.id === draft.taxRateId);
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
      <h3 className="text-sm font-medium text-slate-700">{t('estimates.form.title')}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label={t('shared.customer')} required>
          <select
            value={draft.customerId}
            onChange={(e) => setDraft({ ...draft, customerId: e.target.value })}
            required
            className={inputClass}
          >
            <option value="">{t('shared.choose')}</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('estimates.form.estimateNumber')} required>
          <input
            type="text"
            value={draft.estimateNumber}
            onChange={(e) => setDraft({ ...draft, estimateNumber: e.target.value })}
            required
            maxLength={40}
            className={inputClass}
          />
        </Field>
        <Field label={t('date', { ns: 'common' })} required>
          <input
            type="date"
            value={draft.estimateDate}
            onChange={(e) => setDraft({ ...draft, estimateDate: e.target.value })}
            required
            className={inputClass}
          />
        </Field>
        <Field label={t('estimates.form.expires')}>
          <input
            type="date"
            value={draft.expirationDate}
            onChange={(e) => setDraft({ ...draft, expirationDate: e.target.value })}
            className={inputClass}
          />
        </Field>
        <Field label={t('estimates.form.taxRate')}>
          <select
            value={draft.taxRateId}
            onChange={(e) => setDraft({ ...draft, taxRateId: e.target.value })}
            className={inputClass}
          >
            <option value="">{t('shared.noTax')}</option>
            {taxRates
              .filter((r) => r.isActive)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({Number(r.ratePercent).toFixed(2)}%)
                </option>
              ))}
          </select>
        </Field>
        <Field label={t('memo', { ns: 'common' })}>
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
          <h4 className="text-sm font-medium text-slate-700">{t('estimates.form.lineItems')}</h4>
          <button
            type="button"
            onClick={addLine}
            className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800"
          >
            {t('shared.addLine')}
          </button>
        </div>
        <div className="overflow-x-auto rounded-md border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">{t('shared.incomeAccount')}</th>
                <th className="px-3 py-2 text-left">{t('shared.description')}</th>
                <th className="px-3 py-2 text-right">{t('shared.qty')}</th>
                <th className="px-3 py-2 text-right">{t('shared.price')}</th>
                <th className="px-3 py-2 text-center">{t('shared.tax')}</th>
                <th className="px-3 py-2 text-right">{t('amount', { ns: 'common' })}</th>
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
                        <option value="">{t('shared.choose')}</option>
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
                        placeholder={t('estimates.form.descriptionPlaceholder')}
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
                          {t('estimates.form.remove')}
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
                  {t('shared.subtotal')}
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-900">
                  {formatUsd(subtotal.toFixed(4))}
                </td>
                <td></td>
              </tr>
              {taxRate && (
                <tr>
                  <td colSpan={5} className="px-3 py-2 text-right text-slate-600">
                    {t('estimates.form.taxLine', {
                      percent: Number(taxRate.ratePercent).toFixed(2),
                    })}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-900">
                    {formatUsd(taxAmount.toFixed(4))}
                  </td>
                  <td></td>
                </tr>
              )}
              <tr className="font-semibold">
                <td colSpan={5} className="px-3 py-2 text-right text-slate-900">
                  {t('total', { ns: 'common' })}
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
          {mutation.isPending ? t('estimates.form.creating') : t('estimates.form.submit')}
        </button>
      </div>

      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error, t)}
        </div>
      )}
    </form>
  );
}

function EstimateDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation('sales');
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
          ← {t('back', { ns: 'common' })}
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
                  alert(err instanceof Error ? err.message : t('shared.pdfFailed'));
                } finally {
                  setDownloading(false);
                }
              }}
              disabled={downloading}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
            >
              {downloading ? t('shared.generatingPdf') : t('shared.downloadPdf')}
            </button>
            {data.status === 'draft' && (
              <button
                type="button"
                onClick={() => statusMutation.mutate('sent')}
                disabled={statusMutation.isPending}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
              >
                {t('estimates.detail.markSent')}
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
                  {t('estimates.detail.markAccepted')}
                </button>
                <button
                  type="button"
                  onClick={() => statusMutation.mutate('declined')}
                  disabled={statusMutation.isPending}
                  className="rounded-md border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm text-rose-800 hover:bg-rose-100"
                >
                  {t('estimates.detail.decline')}
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
                {t('estimates.detail.convert')}
              </button>
            )}
            {data.status !== 'converted' && (
              <button
                type="button"
                onClick={() => {
                  if (
                    confirm(
                      t('estimates.detail.deleteConfirm', { number: data.estimateNumber }),
                    )
                  )
                    deleteMutation.mutate();
                }}
                className="rounded-md border border-rose-200 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50"
              >
                {t('delete', { ns: 'common' })}
              </button>
            )}
          </div>
        )}
      </div>

      {detailQ.isLoading && (
        <p className="text-sm text-slate-500">{t('loading', { ns: 'common' })}</p>
      )}
      {detailQ.isError && (
        <p className="text-sm text-rose-600">
          {detailQ.error instanceof Error ? detailQ.error.message : t('shared.failedToLoad')}
        </p>
      )}

      {data && (
        <div className="space-y-4">
          <div className="rounded-md border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-xs uppercase tracking-wider text-slate-500">
                  {t('estimates.detail.label')}
                </div>
                <div className="text-2xl font-semibold tracking-tight text-slate-900">
                  {data.estimateNumber}
                </div>
                <div className="text-sm text-slate-600">
                  {t('estimates.detail.forCustomer', { name: data.customerName ?? '—' })} ·{' '}
                  {data.estimateDate}
                </div>
                {data.expirationDate && (
                  <div className="text-xs text-slate-500">
                    {t('estimates.detail.expiresOn', { date: data.expirationDate })}
                  </div>
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
                  {t(`estimates.status.${data.status}`)}
                </span>
                {data.convertedInvoiceId && (
                  <div className="mt-1 text-xs text-slate-500">
                    {t('estimates.detail.invoiceId', {
                      id: data.convertedInvoiceId.slice(0, 8),
                    })}
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
                  <th className="px-4 py-2 text-left font-medium">{t('shared.description')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('shared.qty')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('shared.price')}</th>
                  <th className="px-4 py-2 text-center font-medium">{t('shared.tax')}</th>
                  <th className="px-4 py-2 text-right font-medium">
                    {t('amount', { ns: 'common' })}
                  </th>
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
                    {t('shared.subtotal')}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(data.subtotal)}
                  </td>
                </tr>
                {Number(data.taxAmount) > 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-2 text-right text-slate-600">
                      {t('shared.tax')}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-900">
                      {formatUsd(data.taxAmount)}
                    </td>
                  </tr>
                )}
                <tr className="font-semibold">
                  <td colSpan={5} className="px-4 py-2 text-right text-slate-900">
                    {t('total', { ns: 'common' })}
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
              {formatError(statusMutation.error ?? deleteMutation.error, t)}
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
  const { t } = useTranslation('sales');
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
            {t('estimates.convert.title')}
          </h3>
          <p className="text-xs text-slate-500">
            {t('estimates.convert.description', {
              number: estimate.estimateNumber,
              total: formatUsd(estimate.total),
            })}
          </p>
        </div>

        <Field label={t('estimates.convert.invoiceNumber')} required>
          <input
            type="text"
            value={invoiceNumber}
            onChange={(e) => setInvoiceNumber(e.target.value)}
            required
            maxLength={40}
            className={inputClass}
          />
        </Field>
        <Field label={t('estimates.convert.invoiceDate')} required>
          <input
            type="date"
            value={invoiceDate}
            onChange={(e) => setInvoiceDate(e.target.value)}
            required
            className={inputClass}
          />
        </Field>
        <Field label={t('estimates.convert.dueDate')}>
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
            {mutation.isPending ? t('estimates.convert.converting') : t('estimates.convert.submit')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
          >
            {t('cancel', { ns: 'common' })}
          </button>
        </div>

        {mutation.isError && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {formatError(mutation.error, t)}
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

function formatError(err: unknown, t: TFunction<'sales'>): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? t('shared.errorLabel')}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : t('shared.failed');
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
