import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface PnlResponse {
  start: string;
  end: string;
  totalRevenue: string;
  totalExpenses: string;
  netIncome: string;
}

interface AgingResponse {
  asOf: string;
  totals: {
    current: string;
    days1to30: string;
    days31to60: string;
    days61to90: string;
    days91plus: string;
    total: string;
  };
}

interface InvoiceListRow {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  status: 'open' | 'partial' | 'paid' | 'void';
  total: string;
  balanceDue: string;
  customerName: string;
}

interface BillListRow {
  id: string;
  billNumber: string;
  billDate: string;
  dueDate: string;
  status: 'open' | 'partial' | 'paid' | 'void';
  total: string;
  balanceDue: string;
  vendorName: string;
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const firstOfMonth = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

function formatUsd(s: string): string {
  if (!s) return '$0.00';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

const STATUS_COLOR: Record<InvoiceListRow['status'], string> = {
  open: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  partial: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  paid: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  void: 'bg-slate-100 text-slate-500 ring-slate-300',
};

export function Dashboard({ onNavigate }: { onNavigate?: (view: string) => void }) {
  const { companyId } = useCurrentCompany();
  const today = todayIso();
  const monthStart = firstOfMonth();

  const pnl = useQuery({
    queryKey: ['dashboard-pnl', companyId, monthStart, today],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<PnlResponse>(
        `/ledger/reports/pnl?start=${monthStart}&end=${today}&basis=accrual`,
        { companyId },
      ),
  });

  const ar = useQuery({
    queryKey: ['dashboard-ar-aging', companyId, today],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<AgingResponse>(`/ledger/reports/ar-aging?asOf=${today}`, { companyId }),
  });

  const ap = useQuery({
    queryKey: ['dashboard-ap-aging', companyId, today],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<AgingResponse>(`/ledger/reports/ap-aging?asOf=${today}`, { companyId }),
  });

  const invoices = useQuery({
    queryKey: ['dashboard-invoices', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ invoices: InvoiceListRow[] }>('/invoices?status=open', { companyId }),
  });

  const bills = useQuery({
    queryKey: ['dashboard-bills', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ bills: BillListRow[] }>('/bills?status=open', { companyId }),
  });

  const recentInvoices = useMemo(() => (invoices.data?.invoices ?? []).slice(0, 5), [invoices.data]);
  const recentBills = useMemo(() => (bills.data?.bills ?? []).slice(0, 5), [bills.data]);
  const overdueInvoices = useMemo(
    () =>
      (invoices.data?.invoices ?? []).filter((i) => i.dueDate < today && Number(i.balanceDue) > 0)
        .length,
    [invoices.data, today],
  );
  const overdueBills = useMemo(
    () =>
      (bills.data?.bills ?? []).filter((b) => b.dueDate < today && Number(b.balanceDue) > 0).length,
    [bills.data, today],
  );

  const monthLabel = new Date(today + 'T00:00:00Z').toLocaleString('default', {
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Dashboard</h2>
        <p className="text-sm text-slate-500">
          Snapshot for {monthLabel} (month-to-date) and outstanding A/R + A/P as of {today}.
        </p>
      </div>

      {/* ----------- KPI tiles ------------- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile
          label="Net income"
          sub={`MTD · ${monthLabel}`}
          value={pnl.data ? formatUsd(pnl.data.netIncome) : '—'}
          tone={pnl.data && Number(pnl.data.netIncome) >= 0 ? 'emerald' : 'rose'}
          loading={pnl.isLoading}
        />
        <Tile
          label="Revenue"
          sub={`MTD · ${monthLabel}`}
          value={pnl.data ? formatUsd(pnl.data.totalRevenue) : '—'}
          tone="emerald"
          loading={pnl.isLoading}
        />
        <Tile
          label="A/R outstanding"
          sub={
            overdueInvoices > 0
              ? `${overdueInvoices} overdue invoice${overdueInvoices === 1 ? '' : 's'}`
              : 'all current'
          }
          value={ar.data ? formatUsd(ar.data.totals.total) : '—'}
          tone={overdueInvoices > 0 ? 'amber' : 'slate'}
          loading={ar.isLoading}
          onClick={() => onNavigate?.('reports:ar-aging')}
        />
        <Tile
          label="A/P outstanding"
          sub={
            overdueBills > 0
              ? `${overdueBills} overdue bill${overdueBills === 1 ? '' : 's'}`
              : 'all current'
          }
          value={ap.data ? formatUsd(ap.data.totals.total) : '—'}
          tone={overdueBills > 0 ? 'amber' : 'slate'}
          loading={ap.isLoading}
          onClick={() => onNavigate?.('reports:ap-aging')}
        />
      </div>

      {/* ----------- Recent activity ------------- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RecentList
          title="Recent open invoices"
          empty="No open invoices."
          isLoading={invoices.isLoading}
          rows={recentInvoices.map((i) => ({
            id: i.id,
            primary: i.customerName,
            secondary: `${i.invoiceNumber} · due ${i.dueDate}`,
            amount: i.balanceDue,
            status: i.status,
          }))}
          actionLabel="View all"
          onAction={() => onNavigate?.('invoices')}
        />
        <RecentList
          title="Recent open bills"
          empty="No open bills."
          isLoading={bills.isLoading}
          rows={recentBills.map((b) => ({
            id: b.id,
            primary: b.vendorName,
            secondary: `${b.billNumber} · due ${b.dueDate}`,
            amount: b.balanceDue,
            status: b.status,
          }))}
          actionLabel="View all"
          onAction={() => onNavigate?.('bills')}
        />
      </div>

      {/* ----------- Quick actions ------------- */}
      <div className="rounded-md border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-medium text-slate-700">Quick actions</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          <QuickAction onClick={() => onNavigate?.('invoices')}>+ New invoice</QuickAction>
          <QuickAction onClick={() => onNavigate?.('bills')}>+ New bill</QuickAction>
          <QuickAction onClick={() => onNavigate?.('payments')}>+ Receive payment</QuickAction>
          <QuickAction onClick={() => onNavigate?.('banking')}>Import bank CSV</QuickAction>
          <QuickAction onClick={() => onNavigate?.('new-entry')}>+ Journal entry</QuickAction>
          <QuickAction onClick={() => onNavigate?.('import')}>Import from QuickBooks</QuickAction>
        </div>
      </div>
    </div>
  );
}

function Tile({
  label,
  sub,
  value,
  tone,
  loading,
  onClick,
}: {
  label: string;
  sub: string;
  value: string;
  tone: 'emerald' | 'rose' | 'amber' | 'slate';
  loading?: boolean;
  onClick?: () => void;
}) {
  const toneClass = {
    emerald: 'border-emerald-200 bg-emerald-50',
    rose: 'border-rose-200 bg-rose-50',
    amber: 'border-amber-200 bg-amber-50',
    slate: 'border-slate-200 bg-white',
  }[tone];
  const valueColor = {
    emerald: 'text-emerald-700',
    rose: 'text-rose-700',
    amber: 'text-amber-800',
    slate: 'text-slate-900',
  }[tone];
  const Wrap: React.ElementType = onClick ? 'button' : 'div';
  return (
    <Wrap
      onClick={onClick}
      className={
        'rounded-md border p-4 text-left transition-colors ' +
        toneClass +
        (onClick ? ' hover:brightness-95 focus:outline-none focus:ring-2 focus:ring-slate-400' : '')
      }
      type={onClick ? 'button' : undefined}
    >
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className={'mt-1 font-mono text-2xl ' + valueColor}>
        {loading ? '…' : value}
      </div>
      <div className="mt-1 text-xs text-slate-500">{sub}</div>
    </Wrap>
  );
}

function RecentList({
  title,
  empty,
  isLoading,
  rows,
  actionLabel,
  onAction,
}: {
  title: string;
  empty: string;
  isLoading: boolean;
  rows: Array<{
    id: string;
    primary: string;
    secondary: string;
    amount: string;
    status: 'open' | 'partial' | 'paid' | 'void';
  }>;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5">
        <h3 className="text-sm font-medium text-slate-700">{title}</h3>
        <button
          type="button"
          onClick={onAction}
          className="text-xs text-slate-600 underline hover:text-slate-900"
        >
          {actionLabel}
        </button>
      </div>
      {isLoading ? (
        <p className="px-4 py-3 text-sm text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-200">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <div>
                <div className="text-slate-900">{r.primary}</div>
                <div className="text-xs text-slate-500">{r.secondary}</div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_COLOR[r.status]}`}
                >
                  {r.status}
                </span>
                <span className="font-mono text-slate-900">{formatUsd(r.amount)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function QuickAction({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50"
    >
      {children}
    </button>
  );
}
