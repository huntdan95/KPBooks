import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { Icon, type IconName } from './ui/Icon';
import { SkeletonStat } from './ui/Skeleton';

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

interface ComplianceExpiringResponse {
  withinDays: number;
  rows: Array<{
    vendorId: string;
    displayName: string;
    documentType: 'license' | 'general_liability' | 'workers_comp';
    expirationDate: string;
    daysUntilExpiration: number;
  }>;
}

interface CashFlowForecastResponse {
  asOf: string;
  startingBalance: string;
  cashAccounts: Array<{ accountId: string; code: string; name: string; balance: string }>;
  totals: {
    inflows: string;
    outflows: string;
    netChange: string;
    endingBalance: string;
  };
}

interface ActivityResp {
  rows: Array<{
    id: string;
    occurredAt: string;
    action: string;
    entityType: string;
    summary: string;
    actorEmail: string | null;
  }>;
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const firstOfMonth = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
};
const daysAgoIso = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

function formatUsd(s: string): string {
  if (!s) return '$0.00';
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
  const sevenDaysAgo = daysAgoIso(7);

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

  const compliance = useQuery({
    queryKey: ['dashboard-compliance', companyId],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<ComplianceExpiringResponse>('/ledger/reports/compliance-expiring?withinDays=30', {
        companyId,
      }),
  });

  // Cash position (from the forecast endpoint -- gives us starting balance +
  // 30-day net change in one round trip).
  const forecast = useQuery({
    queryKey: ['dashboard-forecast', companyId, today],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<CashFlowForecastResponse>(
        `/ledger/reports/cash-flow-forecast?asOf=${today}&horizonDays=30`,
        { companyId },
      ),
  });

  // Recent activity (last 7 days, capped to 8 rows for the card).
  const activity = useQuery({
    queryKey: ['dashboard-activity', companyId, sevenDaysAgo, today],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<ActivityResp>(`/activity?from=${sevenDaysAgo}&to=${today}&limit=8`, { companyId }),
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
  const expiringCount = compliance.data?.rows.length ?? 0;
  const alreadyExpired = useMemo(
    () => (compliance.data?.rows ?? []).filter((r) => r.daysUntilExpiration < 0).length,
    [compliance.data],
  );

  const monthLabel = new Date(today + 'T00:00:00Z').toLocaleString('default', {
    month: 'long',
    year: 'numeric',
  });

  const cashTrend =
    forecast.data && Number(forecast.data.totals.netChange) >= 0 ? 'up' : 'down';

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight text-slate-900">
            {greeting()}
          </h2>
          <p className="mt-0.5 text-sm text-slate-500">
            Snapshot for {monthLabel} (month-to-date) and outstanding A/R + A/P as of {today}.
          </p>
        </div>
      </div>

      {expiringCount > 0 && (
        <button
          type="button"
          onClick={() => onNavigate?.('workers')}
          className={
            'flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-all ' +
            (alreadyExpired > 0
              ? 'border-rose-300 bg-rose-50 text-rose-900 hover:bg-rose-100/70'
              : 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100/70')
          }
        >
          <Icon
            name="alert-triangle"
            className={'mt-0.5 h-4 w-4 shrink-0 ' + (alreadyExpired > 0 ? 'text-rose-600' : 'text-amber-600')}
          />
          <div className="flex-1">
            <strong>Compliance alerts:</strong>{' '}
            {alreadyExpired > 0
              ? `${alreadyExpired} expired, ${expiringCount - alreadyExpired} expiring within 30 days`
              : `${expiringCount} subcontractor doc${expiringCount === 1 ? '' : 's'} expiring within 30 days`}
            <span className="ml-1 text-xs opacity-80">
              (license / GL / WC across your subs — click to review)
            </span>
          </div>
          <span className="rounded-md bg-white/70 px-2 py-1 font-mono text-xs">
            {expiringCount}
          </span>
        </button>
      )}

      {/* ----------- KPI tiles (5 columns when cash forecast loads) ------------- */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {forecast.isLoading ? (
          <SkeletonStat />
        ) : (
          <Tile
            icon="banknote"
            label="Cash on hand"
            sub={
              forecast.data
                ? `${forecast.data.cashAccounts.length} account${forecast.data.cashAccounts.length === 1 ? '' : 's'}`
                : '—'
            }
            value={forecast.data ? formatUsd(forecast.data.startingBalance) : '—'}
            tone="slate"
            trend={
              forecast.data
                ? {
                    direction: cashTrend,
                    label: `${cashTrend === 'up' ? '+' : ''}${formatUsd(forecast.data.totals.netChange)} 30d`,
                  }
                : null
            }
            onClick={() => onNavigate?.('reports:cash-flow-forecast')}
          />
        )}
        {pnl.isLoading ? (
          <SkeletonStat />
        ) : (
          <Tile
            icon="trending-up"
            label="Net income"
            sub={`MTD · ${monthLabel}`}
            value={pnl.data ? formatUsd(pnl.data.netIncome) : '—'}
            tone={pnl.data && Number(pnl.data.netIncome) >= 0 ? 'emerald' : 'rose'}
            onClick={() => onNavigate?.('reports:pnl')}
          />
        )}
        {ar.isLoading ? (
          <SkeletonStat />
        ) : (
          <Tile
            icon="arrow-down-right"
            label="A/R outstanding"
            sub={
              overdueInvoices > 0
                ? `${overdueInvoices} overdue invoice${overdueInvoices === 1 ? '' : 's'}`
                : 'all current'
            }
            value={ar.data ? formatUsd(ar.data.totals.total) : '—'}
            tone={overdueInvoices > 0 ? 'amber' : 'slate'}
            onClick={() => onNavigate?.('reports:ar-aging')}
          />
        )}
        {ap.isLoading ? (
          <SkeletonStat />
        ) : (
          <Tile
            icon="arrow-up-right"
            label="A/P outstanding"
            sub={
              overdueBills > 0
                ? `${overdueBills} overdue bill${overdueBills === 1 ? '' : 's'}`
                : 'all current'
            }
            value={ap.data ? formatUsd(ap.data.totals.total) : '—'}
            tone={overdueBills > 0 ? 'amber' : 'slate'}
            onClick={() => onNavigate?.('reports:ap-aging')}
          />
        )}
      </div>

      {/* ----------- Recent open invoices + bills ------------- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <RecentList
          title="Recent open invoices"
          icon="file-stack"
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
          icon="receipt"
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

      {/* ----------- Activity feed + Quick actions side-by-side ------------- */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ActivityFeed
            isLoading={activity.isLoading}
            rows={activity.data?.rows ?? []}
            onSeeAll={() => onNavigate?.('activity')}
          />
        </div>
        <QuickActionsPanel onNavigate={onNavigate ?? (() => {})} />
      </div>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Working late';
}

const TONE_CLASSES = {
  slate: { card: 'bg-white border-slate-200', value: 'text-slate-900', icon: 'bg-slate-100 text-slate-600' },
  emerald: {
    card: 'bg-gradient-to-br from-emerald-50 to-white border-emerald-200',
    value: 'text-emerald-700',
    icon: 'bg-emerald-100 text-emerald-700',
  },
  rose: {
    card: 'bg-gradient-to-br from-rose-50 to-white border-rose-200',
    value: 'text-rose-700',
    icon: 'bg-rose-100 text-rose-700',
  },
  amber: {
    card: 'bg-gradient-to-br from-amber-50 to-white border-amber-200',
    value: 'text-amber-800',
    icon: 'bg-amber-100 text-amber-700',
  },
} as const;

function Tile({
  icon,
  label,
  sub,
  value,
  tone,
  trend,
  onClick,
}: {
  icon: IconName;
  label: string;
  sub: string;
  value: string;
  tone: 'emerald' | 'rose' | 'amber' | 'slate';
  trend?: { direction: 'up' | 'down'; label: string } | null;
  onClick?: () => void;
}) {
  const t = TONE_CLASSES[tone];
  const Wrap: React.ElementType = onClick ? 'button' : 'div';
  return (
    <Wrap
      onClick={onClick}
      type={onClick ? 'button' : undefined}
      className={
        'group relative overflow-hidden rounded-lg border p-4 text-left transition-all ' +
        t.card +
        (onClick
          ? ' cursor-pointer hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-slate-900/20'
          : '')
      }
    >
      <div className="flex items-start justify-between gap-2">
        <div
          className={
            'flex h-8 w-8 items-center justify-center rounded-md transition-transform group-hover:scale-110 ' +
            t.icon
          }
        >
          <Icon name={icon} className="h-4 w-4" strokeWidth={2} />
        </div>
        {trend && (
          <span
            className={
              'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px] font-medium ' +
              (trend.direction === 'up'
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-rose-50 text-rose-700')
            }
          >
            <Icon
              name={trend.direction === 'up' ? 'trending-up' : 'trending-down'}
              className="h-3 w-3"
              strokeWidth={2.25}
            />
            {trend.label}
          </span>
        )}
      </div>
      <div className="mt-3 text-[11px] font-medium uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className={'mt-0.5 font-mono text-2xl font-semibold tabular-nums ' + t.value}>
        {value}
      </div>
      <div className="mt-1 text-xs text-slate-500">{sub}</div>
    </Wrap>
  );
}

function RecentList({
  title,
  icon,
  empty,
  isLoading,
  rows,
  actionLabel,
  onAction,
}: {
  title: string;
  icon: IconName;
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
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/50 px-4 py-2.5">
        <h3 className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <Icon name={icon} className="h-4 w-4 text-slate-400" />
          {title}
        </h3>
        <button
          type="button"
          onClick={onAction}
          className="flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900"
        >
          {actionLabel}
          <Icon name="arrow-right" className="h-3 w-3" strokeWidth={2} />
        </button>
      </div>
      {isLoading ? (
        <div className="divide-y divide-slate-100">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="space-y-1.5">
                <div className="h-3 w-32 animate-pulse rounded bg-slate-200/70" />
                <div className="h-2.5 w-24 animate-pulse rounded bg-slate-200/50" />
              </div>
              <div className="h-3 w-16 animate-pulse rounded bg-slate-200/70" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-slate-50"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-slate-900">{r.primary}</div>
                <div className="truncate text-xs text-slate-500">{r.secondary}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset ${STATUS_COLOR[r.status]}`}
                >
                  {r.status}
                </span>
                <span className="font-mono text-sm font-medium tabular-nums text-slate-900">
                  {formatUsd(r.amount)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ACTIVITY_ICON: Record<string, IconName> = {
  posted_entry: 'check',
  voided_payment: 'x',
  voided_bill: 'x',
  voided_invoice: 'x',
  merged_customer: 'users',
  merged_vendor: 'building-2',
};

const ACTIVITY_TONE: Record<string, string> = {
  posted_entry: 'bg-emerald-100 text-emerald-700',
  voided_payment: 'bg-rose-100 text-rose-700',
  voided_bill: 'bg-rose-100 text-rose-700',
  voided_invoice: 'bg-rose-100 text-rose-700',
  merged_customer: 'bg-sky-100 text-sky-700',
  merged_vendor: 'bg-sky-100 text-sky-700',
};

function ActivityFeed({
  isLoading,
  rows,
  onSeeAll,
}: {
  isLoading: boolean;
  rows: ActivityResp['rows'];
  onSeeAll: () => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50/50 px-4 py-2.5">
        <h3 className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <Icon name="history" className="h-4 w-4 text-slate-400" />
          Recent activity
        </h3>
        <button
          type="button"
          onClick={onSeeAll}
          className="flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-slate-900"
        >
          See all
          <Icon name="arrow-right" className="h-3 w-3" strokeWidth={2} />
        </button>
      </div>
      {isLoading ? (
        <div className="divide-y divide-slate-100">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-start gap-3 px-4 py-3">
              <div className="h-7 w-7 shrink-0 animate-pulse rounded-md bg-slate-200/70" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-3/4 animate-pulse rounded bg-slate-200/70" />
                <div className="h-2.5 w-1/3 animate-pulse rounded bg-slate-200/50" />
              </div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-slate-500">
          No activity in the last 7 days.
        </p>
      ) : (
        <ol className="divide-y divide-slate-100">
          {rows.map((r) => {
            const icon = ACTIVITY_ICON[r.action] ?? 'info';
            const tone = ACTIVITY_TONE[r.action] ?? 'bg-slate-100 text-slate-600';
            return (
              <li key={r.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                <div
                  className={
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md ' + tone
                  }
                >
                  <Icon name={icon} className="h-3.5 w-3.5" strokeWidth={2.25} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-slate-900">{r.summary}</div>
                  <div className="text-[11px] text-slate-500">
                    {formatRelativeTime(r.occurredAt)}
                    {r.actorEmail && ` · ${r.actorEmail}`}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

const QUICK_ACTIONS: Array<{ id: string; label: string; icon: IconName; target: string }> = [
  { id: 'invoice', label: 'New invoice', icon: 'file-stack', target: 'invoices' },
  { id: 'bill', label: 'New bill', icon: 'receipt', target: 'bills' },
  { id: 'payment', label: 'Receive payment', icon: 'credit-card', target: 'payments' },
  { id: 'banking', label: 'Import bank CSV', icon: 'upload-cloud', target: 'banking' },
  { id: 'je', label: 'Journal entry', icon: 'plus-square', target: 'new-entry' },
  { id: 'iif', label: 'Import .iif', icon: 'package', target: 'import' },
];

function QuickActionsPanel({ onNavigate }: { onNavigate: (view: string) => void }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 bg-slate-50/50 px-4 py-2.5">
        <h3 className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <Icon name="sparkles" className="h-4 w-4 text-slate-400" />
          Quick actions
        </h3>
      </div>
      <div className="grid grid-cols-2 gap-1 p-2">
        {QUICK_ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onNavigate(a.target)}
            className="group flex flex-col items-start gap-2 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-slate-50"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-100 text-slate-600 transition-colors group-hover:bg-slate-900 group-hover:text-white">
              <Icon name={a.icon} className="h-3.5 w-3.5" strokeWidth={2} />
            </div>
            <span className="text-xs font-medium text-slate-700 group-hover:text-slate-900">
              {a.label}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
