import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type PaymentType = 'customer_received' | 'vendor_sent';
type PaymentMethod = 'check' | 'cash' | 'eft' | 'credit_card' | 'other';
type PaymentStatus = 'posted' | 'void';

interface PaymentRow {
  id: string;
  paymentType: PaymentType;
  paymentDate: string;
  paymentMethod: PaymentMethod;
  reference: string | null;
  amount: string;
  status: PaymentStatus;
  customerName: string | null;
  vendorName: string | null;
  voidedAt: string | null;
}

interface Customer {
  id: string;
  displayName: string;
  isActive: boolean;
}

interface Vendor {
  id: string;
  displayName: string;
  isActive: boolean;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subtype: string;
  isActive: boolean;
}

interface OpenInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  status: 'open' | 'partial' | 'paid' | 'void';
  total: string;
  balanceDue: string;
  customerId: string;
  customerName: string;
}

interface OpenBill {
  id: string;
  billNumber: string;
  billDate: string;
  dueDate: string;
  status: 'open' | 'partial' | 'paid' | 'void';
  total: string;
  balanceDue: string;
  vendorId: string;
  vendorName: string;
}

const today = () => new Date().toISOString().slice(0, 10);

const STATUS_COLOR: Record<PaymentStatus, string> = {
  posted: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
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

function formatUsd(s: string): string {
  if (!s) return '$0.00';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

export function PaymentsList() {
  const { t } = useTranslation(['purchases', 'common']);
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'list' | { type: 'new'; payType: PaymentType }>('list');

  const paymentsQuery = useQuery({
    queryKey: ['payments', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ payments: PaymentRow[] }>('/payments', { companyId }),
  });

  const voidMutation = useMutation({
    mutationFn: async (paymentId: string) =>
      api<{ id: string; voidedJournalEntryId: string }>(`/payments/${paymentId}/void`, {
        method: 'POST',
        companyId,
        body: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['payments', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['invoices', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['bills', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['trial-balance', companyId] });
    },
  });

  if (mode !== 'list') {
    return (
      <NewPayment
        payType={mode.payType}
        onCancel={() => setMode('list')}
        onSaved={() => {
          setMode('list');
          void queryClient.invalidateQueries({ queryKey: ['payments', companyId] });
          void queryClient.invalidateQueries({ queryKey: ['invoices', companyId] });
          void queryClient.invalidateQueries({ queryKey: ['bills', companyId] });
          void queryClient.invalidateQueries({ queryKey: ['trial-balance', companyId] });
        }}
      />
    );
  }

  const list = paymentsQuery.data?.payments ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            {t('payments.title')}
          </h2>
          <p className="text-sm text-slate-500">{t('onFile', { count: list.length })}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode({ type: 'new', payType: 'customer_received' })}
            className="whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            {t('payments.receiveCta')}
          </button>
          <button
            type="button"
            onClick={() => setMode({ type: 'new', payType: 'vendor_sent' })}
            className="whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            {t('payments.payBillCta')}
          </button>
        </div>
      </div>

      {paymentsQuery.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {paymentsQuery.isError && (
        <p className="text-sm text-rose-600">
          {paymentsQuery.error instanceof Error
            ? paymentsQuery.error.message
            : t('payments.loadFailed')}
        </p>
      )}

      {!paymentsQuery.isLoading && list.length === 0 && (
        <p className="text-sm text-slate-500">{t('payments.empty')}</p>
      )}

      {list.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">{t('payments.table.date')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('payments.table.type')}</th>
                <th className="px-4 py-2 text-left font-medium">
                  {t('payments.table.counterparty')}
                </th>
                <th className="px-4 py-2 text-left font-medium">{t('payments.table.method')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('payments.table.reference')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('payments.table.amount')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('payments.table.status')}</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {list.map((p) => (
                <tr key={p.id} className={p.status === 'void' ? 'opacity-60' : ''}>
                  <td className="px-4 py-2 text-slate-700">{p.paymentDate}</td>
                  <td className="px-4 py-2 text-slate-700">
                    {p.paymentType === 'customer_received'
                      ? t('payments.type.received')
                      : t('payments.type.sent')}
                  </td>
                  <td className="px-4 py-2 text-slate-900">
                    {p.customerName ?? p.vendorName ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-slate-700">
                    {t(`payments.method.${p.paymentMethod}`)}
                  </td>
                  <td className="px-4 py-2 font-mono text-slate-700">{p.reference ?? '—'}</td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(p.amount)}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_COLOR[p.status]}`}
                    >
                      {t(`payments.status.${p.status}`)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    {p.status === 'posted' && (
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm(t('payments.voidConfirm'))) {
                            voidMutation.mutate(p.id);
                          }
                        }}
                        disabled={voidMutation.isPending}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
                      >
                        {t('common:void')}
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
          {formatError(voidMutation.error, {
            error: t('errors.label'),
            fallback: t('errors.operationFailed'),
          })}
        </div>
      )}
    </div>
  );
}

function NewPayment({
  payType,
  onCancel,
  onSaved,
}: {
  payType: PaymentType;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation(['purchases', 'common']);
  const { companyId } = useCurrentCompany();
  const isReceive = payType === 'customer_received';

  const customersQuery = useQuery({
    queryKey: ['customers', companyId],
    enabled: Boolean(companyId) && isReceive,
    queryFn: () => api<{ customers: Customer[] }>('/customers?active=true', { companyId }),
  });
  const vendorsQuery = useQuery({
    queryKey: ['vendors', companyId],
    enabled: Boolean(companyId) && !isReceive,
    queryFn: () => api<{ vendors: Vendor[] }>('/vendors?active=true', { companyId }),
  });
  const accountsQuery = useQuery({
    queryKey: ['accounts', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ accounts: Account[] }>('/ledger/accounts?active=true', { companyId }),
  });
  const openInvoicesQuery = useQuery({
    queryKey: ['invoices', companyId, 'all'],
    enabled: Boolean(companyId) && isReceive,
    queryFn: () => api<{ invoices: OpenInvoice[] }>('/invoices', { companyId }),
  });
  const openBillsQuery = useQuery({
    queryKey: ['bills', companyId, 'all'],
    enabled: Boolean(companyId) && !isReceive,
    queryFn: () => api<{ bills: OpenBill[] }>('/bills', { companyId }),
  });

  const counterparties = isReceive
    ? (customersQuery.data?.customers ?? []).filter((c) => c.isActive)
    : (vendorsQuery.data?.vendors ?? []).filter((v) => v.isActive);

  // For "receive payment" the bank account is the deposit target -- usually a
  // bank-subtype asset. For "pay bill" it's the payment source -- bank or
  // credit-card. In both cases let users pick from a shortlist; default to
  // bank/credit-card subtypes but show all active accounts as fallback.
  const bankAccounts = useMemo(() => {
    const all = accountsQuery.data?.accounts ?? [];
    return all
      .filter((a) => a.isActive && (a.subtype === 'bank' || a.subtype === 'credit_card'))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [accountsQuery.data]);

  const [counterpartyId, setCounterpartyId] = useState('');
  const [paymentDate, setPaymentDate] = useState<string>(today);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('check');
  const [reference, setReference] = useState('');
  const [bankAccountId, setBankAccountId] = useState('');
  const [memo, setMemo] = useState('');
  // applications keyed by target id (invoice or bill)
  const [appAmounts, setAppAmounts] = useState<Record<string, string>>({});

  const outstandingDocs = useMemo(() => {
    if (!counterpartyId) return [];
    if (isReceive) {
      return (openInvoicesQuery.data?.invoices ?? [])
        .filter(
          (inv) =>
            inv.customerId === counterpartyId &&
            (inv.status === 'open' || inv.status === 'partial'),
        )
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    }
    return (openBillsQuery.data?.bills ?? [])
      .filter(
        (b) =>
          b.vendorId === counterpartyId && (b.status === 'open' || b.status === 'partial'),
      )
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }, [counterpartyId, isReceive, openInvoicesQuery.data, openBillsQuery.data]);

  const totalAmount = useMemo(() => {
    let sum = '0';
    for (const v of Object.values(appAmounts)) {
      if (v) sum = addCents(sum, v);
    }
    return sum;
  }, [appAmounts]);

  const applications = useMemo(() => {
    return outstandingDocs
      .map((doc) => ({
        targetId: doc.id,
        amount: appAmounts[doc.id] ?? '',
      }))
      .filter((a) => a.amount && Number(a.amount) > 0);
  }, [outstandingDocs, appAmounts]);

  const overApplied = outstandingDocs.some((doc) => {
    const v = appAmounts[doc.id];
    return v && Number(v) > 0 && Number(v) > Number(doc.balanceDue);
  });

  const canSubmit =
    Boolean(counterpartyId) &&
    Boolean(bankAccountId) &&
    Boolean(paymentDate) &&
    applications.length > 0 &&
    Number(totalAmount) > 0 &&
    !overApplied;

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        paymentType: payType,
        paymentDate,
        paymentMethod,
        reference: reference.trim() || undefined,
        bankAccountId,
        amount: totalAmount,
        memo: memo.trim() || undefined,
        applications: applications.map((a) =>
          isReceive ? { invoiceId: a.targetId, amount: a.amount } : { billId: a.targetId, amount: a.amount },
        ),
      };
      if (isReceive) body.customerId = counterpartyId;
      else body.vendorId = counterpartyId;
      return api<{ id: string; postedJournalEntryId: string; amount: string }>('/payments', {
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

  function payInFull(docId: string, balanceDue: string) {
    setAppAmounts((m) => ({ ...m, [docId]: balanceDue }));
  }
  function clearApplication(docId: string) {
    setAppAmounts((m) => {
      const { [docId]: _, ...rest } = m;
      return rest;
    });
  }

  if (
    customersQuery.isLoading ||
    vendorsQuery.isLoading ||
    accountsQuery.isLoading ||
    (isReceive ? openInvoicesQuery.isLoading : openBillsQuery.isLoading)
  ) {
    return <p className="text-sm text-slate-500">{t('common:loading')}</p>;
  }

  if (counterparties.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            {isReceive ? t('payments.new.receiveTitle') : t('payments.new.payTitle')}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            {t('common:cancel')}
          </button>
        </div>
        <p className="text-sm text-slate-500">
          {isReceive ? t('payments.new.noCustomers') : t('payments.new.noVendors')}
        </p>
      </div>
    );
  }

  if (bankAccounts.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            {isReceive ? t('payments.new.receiveTitle') : t('payments.new.payTitle')}
          </h2>
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-slate-600 hover:text-slate-900"
          >
            {t('common:cancel')}
          </button>
        </div>
        <p className="text-sm text-slate-500">{t('payments.new.noBankAccounts')}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">
          {isReceive ? t('payments.new.receiveTitle') : t('payments.new.payTitle')}
        </h2>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-slate-600 hover:text-slate-900"
        >
          {t('common:cancel')}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field
          label={isReceive ? t('payments.new.fromCustomer') : t('payments.new.toVendor')}
          required
        >
          <select
            value={counterpartyId}
            onChange={(e) => {
              setCounterpartyId(e.target.value);
              setAppAmounts({});
            }}
            required
            className={inputClass}
          >
            <option value="">{t('payments.new.select')}</option>
            {counterparties.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('payments.new.date')} required>
          <input
            type="date"
            value={paymentDate}
            onChange={(e) => setPaymentDate(e.target.value)}
            required
            className={inputClass}
          />
        </Field>
        <Field
          label={isReceive ? t('payments.new.depositTo') : t('payments.new.payFrom')}
          required
        >
          <select
            value={bankAccountId}
            onChange={(e) => setBankAccountId(e.target.value)}
            required
            className={inputClass}
          >
            <option value="">{t('payments.new.select')}</option>
            {bankAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('payments.new.method')} required>
          <select
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
            required
            className={inputClass}
          >
            <option value="check">{t('payments.method.check')}</option>
            <option value="cash">{t('payments.method.cash')}</option>
            <option value="eft">{t('payments.method.eft')}</option>
            <option value="credit_card">{t('payments.method.credit_card')}</option>
            <option value="other">{t('payments.method.other')}</option>
          </select>
        </Field>
        <Field label={t('payments.new.reference')}>
          <input
            type="text"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            maxLength={120}
            placeholder={t('payments.new.referencePlaceholder')}
            className={inputClass}
          />
        </Field>
        <Field label={t('payments.new.memo')}>
          <input
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            maxLength={500}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium text-slate-700">
          {isReceive ? t('payments.new.applyInvoices') : t('payments.new.applyBills')}
        </h3>
        {!counterpartyId ? (
          <p className="text-sm text-slate-500">
            {isReceive ? t('payments.new.pickCustomer') : t('payments.new.pickVendor')}
          </p>
        ) : outstandingDocs.length === 0 ? (
          <p className="text-sm text-slate-500">
            {isReceive ? t('payments.new.noOpenInvoices') : t('payments.new.noOpenBills')}
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('payments.new.table.number')}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('payments.new.table.date')}
                  </th>
                  <th className="px-3 py-2 text-left font-medium">
                    {t('payments.new.table.due')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t('payments.new.table.total')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t('payments.new.table.balance')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t('payments.new.table.apply')}
                  </th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {outstandingDocs.map((doc) => {
                  const docNumber = isReceive
                    ? (doc as OpenInvoice).invoiceNumber
                    : (doc as OpenBill).billNumber;
                  const docDate = isReceive
                    ? (doc as OpenInvoice).invoiceDate
                    : (doc as OpenBill).billDate;
                  const v = appAmounts[doc.id] ?? '';
                  const overOnThis = v && Number(v) > Number(doc.balanceDue);
                  return (
                    <tr key={doc.id}>
                      <td className="px-3 py-2 font-mono text-slate-900">{docNumber}</td>
                      <td className="px-3 py-2 text-slate-700">{docDate}</td>
                      <td className="px-3 py-2 text-slate-700">{doc.dueDate}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-700">
                        {formatUsd(doc.total)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-900">
                        {formatUsd(doc.balanceDue)}
                      </td>
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          inputMode="decimal"
                          value={v}
                          onChange={(e) =>
                            setAppAmounts((m) => ({
                              ...m,
                              [doc.id]: e.target.value.replace(/[^0-9.]/g, ''),
                            }))
                          }
                          placeholder="0.00"
                          className={
                            'w-28 rounded-md border px-2 py-1.5 text-right font-mono text-sm focus:outline-none ' +
                            (overOnThis
                              ? 'border-rose-400 focus:border-rose-600'
                              : 'border-slate-300 focus:border-slate-900')
                          }
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() =>
                            v ? clearApplication(doc.id) : payInFull(doc.id, doc.balanceDue)
                          }
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                        >
                          {v ? t('payments.new.clear') : t('payments.new.inFull')}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-slate-50 text-sm font-medium">
                <tr>
                  <td colSpan={5} className="px-3 py-2 text-right text-slate-600">
                    {t('payments.new.paymentTotal')}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-900">
                    {formatUsd(totalAmount)}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        {overApplied && (
          <p className="text-xs text-rose-600">{t('payments.new.overApplied')}</p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!canSubmit || mutation.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation.isPending
            ? t('payments.new.posting')
            : isReceive
              ? t('payments.new.savePayment')
              : t('payments.new.saveBillPayment')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
        >
          {t('common:cancel')}
        </button>
      </div>

      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {formatError(mutation.error, {
            error: t('errors.label'),
            fallback: t('errors.operationFailed'),
          })}
        </div>
      )}
    </form>
  );
}

const inputClass =
  'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900';

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

function formatError(err: unknown, labels: { error: string; fallback: string }): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? labels.error}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : labels.fallback;
}
