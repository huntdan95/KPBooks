/**
 * Customer / Vendor drill-down. Click a row in CustomersList or VendorsList
 * to open this view, which aggregates everything we know about the
 * counterparty: profile fields, total billed / paid / open, every invoice
 * (or bill), every payment received (or sent). All from existing endpoints
 * with `customerId=` / `vendorId=` filters -- no new server work.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

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
  notes?: string | null;
}

interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  status: 'open' | 'partial' | 'paid' | 'void';
  total: string;
  balanceDue: string;
}

interface BillRow {
  id: string;
  billNumber: string;
  billDate: string;
  dueDate: string;
  status: 'open' | 'partial' | 'paid' | 'void';
  total: string;
  balanceDue: string;
}

interface PaymentRow {
  id: string;
  paymentDate: string;
  paymentMethod: string;
  reference: string | null;
  amount: string;
  status: 'posted' | 'void';
  paymentType: 'customer_received' | 'vendor_sent';
}

const STATUS_COLOR: Record<InvoiceRow['status'], string> = {
  open: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  partial: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  paid: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  void: 'bg-slate-100 text-slate-500 ring-slate-300',
};

function formatUsd(s: string): string {
  if (!s) return '$0.00';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

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

export function CustomerDetail({
  customerId,
  onBack,
}: {
  customerId: string;
  onBack: () => void;
}) {
  const { t } = useTranslation('purchases');
  const { companyId } = useCurrentCompany();

  const customerQuery = useQuery({
    queryKey: ['customer', companyId, customerId],
    enabled: Boolean(companyId),
    queryFn: () => api<Customer>(`/customers/${customerId}`, { companyId }),
  });
  const invoicesQuery = useQuery({
    queryKey: ['invoices-by-customer', companyId, customerId],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ invoices: InvoiceRow[] }>(`/invoices?customerId=${customerId}`, { companyId }),
  });
  const paymentsQuery = useQuery({
    queryKey: ['payments-by-customer', companyId, customerId],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ payments: PaymentRow[] }>(
        `/payments?customerId=${customerId}&type=customer_received`,
        { companyId },
      ),
  });

  const c = customerQuery.data ?? null;
  const invoices = invoicesQuery.data?.invoices ?? [];
  const payments = paymentsQuery.data?.payments ?? [];

  const totals = useMemo(() => {
    const billed = invoices
      .filter((i) => i.status !== 'void')
      .reduce((acc, i) => addCents(acc, i.total), '0');
    const open = invoices
      .filter((i) => i.status !== 'void')
      .reduce((acc, i) => addCents(acc, i.balanceDue), '0');
    const received = payments
      .filter((p) => p.status === 'posted')
      .reduce((acc, p) => addCents(acc, p.amount), '0');
    return { billed, open, received };
  }, [invoices, payments]);

  return (
    <CounterpartyView
      kind="customer"
      onBack={onBack}
      profile={
        c
          ? {
              displayName: c.displayName,
              companyName: c.companyName,
              accountNumber: c.accountNumber,
              email: c.email,
              phone: c.phone,
              terms: c.defaultTermsDays,
              isActive: c.isActive,
              openingBalance: c.openingBalance,
              extraField: c.taxExempt
                ? { label: t('counterparty.taxExempt'), value: t('counterparty.taxExemptYes') }
                : null,
              notes: c.notes ?? null,
            }
          : null
      }
      isLoading={customerQuery.isLoading}
      kpis={[
        {
          label: t('counterparty.customer.totalBilled'),
          value: formatUsd(totals.billed),
          tone: 'slate',
        },
        {
          label: t('counterparty.customer.totalReceived'),
          value: formatUsd(totals.received),
          tone: 'emerald',
        },
        {
          label: t('counterparty.customer.openBalance'),
          value: formatUsd(totals.open),
          tone: Number(totals.open) > 0 ? 'amber' : 'emerald',
        },
      ]}
      docs={{
        title: t('counterparty.customer.invoicesTitle', { count: invoices.length }),
        empty: t('counterparty.customer.invoicesEmpty'),
        rows: invoices.map((i) => ({
          id: i.id,
          number: i.invoiceNumber,
          date: i.invoiceDate,
          due: i.dueDate,
          status: i.status,
          total: i.total,
          balance: i.balanceDue,
        })),
      }}
      payments={{
        title: t('counterparty.customer.paymentsTitle', { count: payments.length }),
        empty: t('counterparty.customer.paymentsEmpty'),
        rows: payments,
      }}
    />
  );
}

export function VendorDetail({
  vendorId,
  onBack,
}: {
  vendorId: string;
  onBack: () => void;
}) {
  const { t } = useTranslation('purchases');
  const { companyId } = useCurrentCompany();

  const vendorQuery = useQuery({
    queryKey: ['vendor', companyId, vendorId],
    enabled: Boolean(companyId),
    queryFn: () => api<Vendor>(`/vendors/${vendorId}`, { companyId }),
  });
  const billsQuery = useQuery({
    queryKey: ['bills-by-vendor', companyId, vendorId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ bills: BillRow[] }>(`/bills?vendorId=${vendorId}`, { companyId }),
  });
  const paymentsQuery = useQuery({
    queryKey: ['payments-by-vendor', companyId, vendorId],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ payments: PaymentRow[] }>(
        `/payments?vendorId=${vendorId}&type=vendor_sent`,
        { companyId },
      ),
  });

  const v = vendorQuery.data ?? null;
  const bills = billsQuery.data?.bills ?? [];
  const payments = paymentsQuery.data?.payments ?? [];

  const totals = useMemo(() => {
    const billed = bills
      .filter((b) => b.status !== 'void')
      .reduce((acc, b) => addCents(acc, b.total), '0');
    const open = bills
      .filter((b) => b.status !== 'void')
      .reduce((acc, b) => addCents(acc, b.balanceDue), '0');
    const sent = payments
      .filter((p) => p.status === 'posted')
      .reduce((acc, p) => addCents(acc, p.amount), '0');
    return { billed, open, sent };
  }, [bills, payments]);

  return (
    <CounterpartyView
      kind="vendor"
      onBack={onBack}
      profile={
        v
          ? {
              displayName: v.displayName,
              companyName: v.companyName,
              accountNumber: v.accountNumber,
              email: v.email,
              phone: v.phone,
              terms: v.defaultTermsDays,
              isActive: v.isActive,
              openingBalance: v.openingBalance,
              extraField: v.is1099Vendor
                ? {
                    label: t('counterparty.vendor1099'),
                    value: v.taxId
                      ? t('counterparty.taxIdValue', { taxId: v.taxId })
                      : t('counterparty.taxIdMissing'),
                  }
                : null,
              notes: v.notes ?? null,
            }
          : null
      }
      isLoading={vendorQuery.isLoading}
      kpis={[
        {
          label: t('counterparty.vendor.totalBilled'),
          value: formatUsd(totals.billed),
          tone: 'slate',
        },
        {
          label: t('counterparty.vendor.totalPaidOut'),
          value: formatUsd(totals.sent),
          tone: 'emerald',
        },
        {
          label: t('counterparty.vendor.openBalance'),
          value: formatUsd(totals.open),
          tone: Number(totals.open) > 0 ? 'amber' : 'emerald',
        },
      ]}
      docs={{
        title: t('counterparty.vendor.billsTitle', { count: bills.length }),
        empty: t('counterparty.vendor.billsEmpty'),
        rows: bills.map((b) => ({
          id: b.id,
          number: b.billNumber,
          date: b.billDate,
          due: b.dueDate,
          status: b.status,
          total: b.total,
          balance: b.balanceDue,
        })),
      }}
      payments={{
        title: t('counterparty.vendor.paymentsTitle', { count: payments.length }),
        empty: t('counterparty.vendor.paymentsEmpty'),
        rows: payments,
      }}
    />
  );
}

// ─── Shared layout for the detail screen ──────────────────────────────────

interface CounterpartyProfile {
  displayName: string;
  companyName: string | null;
  accountNumber: string | null;
  email: string | null;
  phone: string | null;
  terms: number | null;
  isActive: boolean;
  openingBalance: string;
  extraField: { label: string; value: string } | null;
  notes: string | null;
}

interface DocsSection {
  title: string;
  empty: string;
  rows: Array<{
    id: string;
    number: string;
    date: string;
    due: string;
    status: 'open' | 'partial' | 'paid' | 'void';
    total: string;
    balance: string;
  }>;
}

interface PaymentsSection {
  title: string;
  empty: string;
  rows: PaymentRow[];
}

function CounterpartyView({
  kind,
  onBack,
  profile,
  isLoading,
  kpis,
  docs,
  payments,
}: {
  kind: 'customer' | 'vendor';
  onBack: () => void;
  profile: CounterpartyProfile | null;
  isLoading: boolean;
  kpis: Array<{ label: string; value: string; tone: 'slate' | 'emerald' | 'amber' | 'rose' }>;
  docs: DocsSection;
  payments: PaymentsSection;
}) {
  const { t } = useTranslation(['purchases', 'common']);
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          {kind === 'customer'
            ? t('counterparty.backToCustomers')
            : t('counterparty.backToVendors')}
        </button>
      </div>

      {isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}

      {profile && (
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
                {profile.displayName}
                {!profile.isActive && (
                  <span className="ml-2 align-middle text-sm font-normal text-slate-500">
                    {t('counterparty.inactiveSuffix')}
                  </span>
                )}
              </h2>
              {profile.companyName && (
                <p className="text-sm text-slate-600">{profile.companyName}</p>
              )}
              {profile.accountNumber && (
                <p className="text-xs font-mono text-slate-500">#{profile.accountNumber}</p>
              )}
            </div>
            <div className="flex flex-col items-end gap-0.5 text-xs text-slate-600">
              {profile.email && <span>{profile.email}</span>}
              {profile.phone && <span>{profile.phone}</span>}
              {profile.terms !== null && (
                <span>{t('counterparty.netTerms', { days: profile.terms })}</span>
              )}
              {profile.extraField && (
                <span className="font-medium text-slate-700">
                  {t('counterparty.extraField', {
                    label: profile.extraField.label,
                    value: profile.extraField.value,
                  })}
                </span>
              )}
              {Number(profile.openingBalance) !== 0 && (
                <span>
                  {t('counterparty.openingBalance', {
                    amount: formatUsd(profile.openingBalance),
                  })}
                </span>
              )}
            </div>
          </div>
          {profile.notes && (
            <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
              {profile.notes}
            </p>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {kpis.map((k, i) => (
          <KpiTile key={i} {...k} />
        ))}
      </div>

      <DocsTable {...docs} />
      <PaymentsTable {...payments} />
    </div>
  );
}

function KpiTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'slate' | 'emerald' | 'amber' | 'rose';
}) {
  const toneClass = {
    slate: 'border-slate-200 bg-white text-slate-900',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    rose: 'border-rose-200 bg-rose-50 text-rose-700',
  }[tone];
  return (
    <div className={'rounded-md border p-3 ' + toneClass}>
      <div className="text-xs uppercase tracking-wider opacity-70">{label}</div>
      <div className="mt-1 font-mono text-2xl">{value}</div>
    </div>
  );
}

function DocsTable({ title, empty, rows }: DocsSection) {
  const { t } = useTranslation('purchases');
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-slate-700">{title}</h3>
      {rows.length === 0 ? (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
          {empty}
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">
                  {t('counterparty.docsTable.number')}
                </th>
                <th className="px-4 py-2 text-left font-medium">
                  {t('counterparty.docsTable.date')}
                </th>
                <th className="px-4 py-2 text-left font-medium">
                  {t('counterparty.docsTable.due')}
                </th>
                <th className="px-4 py-2 text-center font-medium">
                  {t('counterparty.docsTable.status')}
                </th>
                <th className="px-4 py-2 text-right font-medium">
                  {t('counterparty.docsTable.total')}
                </th>
                <th className="px-4 py-2 text-right font-medium">
                  {t('counterparty.docsTable.balance')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {rows.map((r) => (
                <tr key={r.id} className={r.status === 'void' ? 'opacity-60' : ''}>
                  <td className="px-4 py-2 font-mono text-slate-900">{r.number}</td>
                  <td className="px-4 py-2 text-slate-700">{r.date}</td>
                  <td className="px-4 py-2 text-slate-700">{r.due}</td>
                  <td className="px-4 py-2 text-center">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_COLOR[r.status]}`}
                    >
                      {t(`bills.status.${r.status}`)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(r.total)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">
                    {r.status === 'void' ? '—' : formatUsd(r.balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PaymentsTable({ title, empty, rows }: PaymentsSection) {
  const { t } = useTranslation('purchases');
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium text-slate-700">{title}</h3>
      {rows.length === 0 ? (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
          {empty}
        </p>
      ) : (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">
                  {t('counterparty.paymentsTable.date')}
                </th>
                <th className="px-4 py-2 text-left font-medium">
                  {t('counterparty.paymentsTable.method')}
                </th>
                <th className="px-4 py-2 text-left font-medium">
                  {t('counterparty.paymentsTable.reference')}
                </th>
                <th className="px-4 py-2 text-center font-medium">
                  {t('counterparty.paymentsTable.status')}
                </th>
                <th className="px-4 py-2 text-right font-medium">
                  {t('counterparty.paymentsTable.amount')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {rows.map((p) => (
                <tr key={p.id} className={p.status === 'void' ? 'opacity-60' : ''}>
                  <td className="px-4 py-2 text-slate-700">{p.paymentDate}</td>
                  <td className="px-4 py-2 text-slate-700">
                    {t(`payments.method.${p.paymentMethod}`, { defaultValue: p.paymentMethod })}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-700">
                    {p.reference ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <span
                      className={
                        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
                        (p.status === 'posted'
                          ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
                          : 'bg-slate-100 text-slate-500 ring-slate-300')
                      }
                    >
                      {t(`payments.status.${p.status}`)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(p.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
