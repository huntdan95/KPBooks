import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { ApiError, api, getApiBase, getIdToken } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type InvoiceStatus = 'open' | 'partial' | 'paid' | 'void';

interface InvoiceLine {
  id: string;
  lineNumber: number;
  accountId: string;
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  taxable: boolean;
}

interface InvoiceDetailData {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  termsDays: number | null;
  status: InvoiceStatus;
  memo: string | null;
  subtotal: string;
  taxAmount: string;
  total: string;
  balanceDue: string;
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  postedJournalEntryId: string;
  voidedJournalEntryId: string | null;
  voidedAt: string | null;
  createdAt: string;
  lines: InvoiceLine[];
}

const STATUS_COLOR: Record<InvoiceStatus, string> = {
  open: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  partial: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  paid: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  void: 'bg-rose-50 text-rose-700 ring-rose-600/20',
};

function formatUsd(s: string | null | undefined): string {
  if (s === null || s === undefined || s === '') return '$0.00';
  const n = Number(s);
  if (!Number.isFinite(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatQty(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 4 });
}

export function InvoiceDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation('sales');
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [downloading, setDownloading] = useState(false);

  const detailQ = useQuery({
    queryKey: ['invoice', id, companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<InvoiceDetailData>(`/invoices/${id}`, { companyId }),
  });

  const voidMutation = useMutation({
    mutationFn: async () =>
      api(`/invoices/${id}/void`, { method: 'POST', companyId, body: {} }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['invoice', id, companyId] });
      void queryClient.invalidateQueries({ queryKey: ['invoices', companyId] });
    },
  });

  async function downloadPdf() {
    if (!detailQ.data) return;
    setDownloading(true);
    try {
      const token = await getIdToken();
      const res = await fetch(`${getApiBase()}/invoices/${id}.pdf`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(companyId ? { 'x-kpbooks-company': companyId } : {}),
        },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          (body && typeof body === 'object' && 'message' in body
            ? String((body as { message?: string }).message)
            : '') || `HTTP ${res.status}`,
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Invoice_${detailQ.data.invoiceNumber.replace(/[^A-Za-z0-9]+/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : t('shared.pdfFailed'));
    } finally {
      setDownloading(false);
    }
  }

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
              onClick={downloadPdf}
              disabled={downloading}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {downloading ? t('shared.generatingPdf') : t('shared.downloadPdf')}
            </button>
            {data.status !== 'void' && (
              <button
                type="button"
                onClick={() => {
                  if (confirm(t('invoiceDetail.voidConfirm', { number: data.invoiceNumber })))
                    voidMutation.mutate();
                }}
                disabled={voidMutation.isPending}
                className="rounded-md border border-rose-200 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50"
              >
                {voidMutation.isPending ? t('invoiceDetail.voiding') : t('invoiceDetail.voidButton')}
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
          {detailQ.error instanceof Error ? detailQ.error.message : t('invoiceDetail.loadFailed')}
        </p>
      )}

      {data && (
        <div className="space-y-4">
          {/* Header card */}
          <div className="rounded-md border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <div className="text-xs uppercase tracking-wider text-slate-500">
                    {t('invoiceDetail.label')}
                  </div>
                  <span
                    className={
                      'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
                      STATUS_COLOR[data.status]
                    }
                  >
                    {t(`invoices.status.${data.status}`)}
                  </span>
                </div>
                <div className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
                  {data.invoiceNumber}
                </div>
                <div className="text-sm text-slate-600">
                  {t('invoiceDetail.for')} <strong>{data.customerName}</strong>
                  {data.customerEmail && (
                    <span className="text-slate-500"> · {data.customerEmail}</span>
                  )}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {t('invoiceDetail.issued', { date: data.invoiceDate })}
                  {data.dueDate && <span> · {t('invoiceDetail.due', { date: data.dueDate })}</span>}
                  {data.termsDays !== null && (
                    <span> · {t('shared.net', { days: data.termsDays })}</span>
                  )}
                </div>
                {data.memo && (
                  <div className="mt-2 text-sm italic text-slate-600">"{data.memo}"</div>
                )}
                {data.status === 'void' && data.voidedAt && (
                  <div className="mt-2 rounded-md bg-rose-50 px-2 py-1 text-xs text-rose-800">
                    {t('invoiceDetail.voidedOn', {
                      date: new Date(data.voidedAt).toLocaleDateString(),
                    })}
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="text-xs uppercase tracking-wider text-slate-500">
                  {t('invoiceDetail.balanceDue')}
                </div>
                <div
                  className={
                    'mt-1 font-mono text-2xl font-bold ' +
                    (Number(data.balanceDue) > 0 ? 'text-rose-700' : 'text-emerald-700')
                  }
                >
                  {formatUsd(data.balanceDue)}
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  {t('invoiceDetail.totalAmount', { amount: formatUsd(data.total) })}
                </div>
              </div>
            </div>
          </div>

          {/* Line items */}
          <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">#</th>
                  <th className="px-4 py-2 text-left font-medium">{t('shared.description')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('shared.qty')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('shared.unitPrice')}</th>
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
                      {formatQty(l.quantity)}
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
                <tr className="font-semibold">
                  <td colSpan={5} className="px-4 py-2 text-right text-slate-900">
                    {t('invoiceDetail.balanceDue')}
                  </td>
                  <td
                    className={
                      'px-4 py-2 text-right font-mono ' +
                      (Number(data.balanceDue) > 0 ? 'text-rose-700' : 'text-emerald-700')
                    }
                  >
                    {formatUsd(data.balanceDue)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {voidMutation.isError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formatError(voidMutation.error, t)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatError(err: unknown, t: TFunction<'sales'>): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? t('shared.errorLabel')}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : t('shared.failed');
}
