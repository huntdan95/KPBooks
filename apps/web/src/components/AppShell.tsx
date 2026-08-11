import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { signOut } from '../lib/firebase';
import { useAuth } from '../lib/auth';
import { Icon } from './ui/Icon';
import { AccountsList } from './AccountsList';
import { BankingList } from './BankingList';
import { BillsList } from './BillsList';
import { Chat } from './Chat';
import { CustomersList } from './CustomersList';
import { Dashboard } from './Dashboard';
import { EstimatesList } from './EstimatesList';
import { Imports } from './Imports';
import { InvoicesList } from './InvoicesList';
import { ItemsList } from './ItemsList';
import { Activity } from './Activity';
import { Documents } from './Documents';
import { FixedAssets } from './FixedAssets';
import { Recurring } from './Recurring';
import { TimeEntries } from './TimeEntries';
import { PayrollRuns } from './PayrollRuns';
import { JournalEntryForm } from './JournalEntryForm';
import { Mileage } from './Mileage';
import { NewCompanyForm } from './NewCompanyForm';
import { NinetyNinePrep } from './NinetyNinePrep';
import { PaymentsList } from './PaymentsList';
import { Reports } from './Reports';
import { Sidebar, type View } from './Sidebar';
import { TaxRates } from './TaxRates';
import { VendorsList } from './VendorsList';
import { Workers } from './Workers';

interface Membership {
  companyId: string;
  companyName: string;
  role: 'owner' | 'admin' | 'bookkeeper' | 'viewer';
}

const PAGE_META: Record<View, { title: string; subtitle?: string }> = {
  dashboard: { title: 'Dashboard', subtitle: 'Today at a glance' },
  chat: { title: 'Ask Claude', subtitle: 'AI bookkeeping assistant' },
  estimates: { title: 'Estimates', subtitle: 'Quotes ready to convert to invoices' },
  invoices: { title: 'Invoices', subtitle: 'Customer-facing A/R documents' },
  customers: { title: 'Customers', subtitle: 'A/R counterparties' },
  bills: { title: 'Bills', subtitle: 'Vendor-facing A/P documents' },
  vendors: { title: 'Vendors', subtitle: 'A/P counterparties' },
  mileage: { title: 'Mileage', subtitle: 'Business-use travel log' },
  workers: { title: 'Workers / 1099', subtitle: 'Contractors, employees, W-9s' },
  banking: { title: 'Banking', subtitle: 'Bank accounts + reconciliation' },
  payments: { title: 'Payments', subtitle: 'Money in and money out' },
  accounts: { title: 'Chart of Accounts', subtitle: 'Your ledger structure' },
  'new-entry': { title: 'New journal entry', subtitle: 'Manual ledger posting' },
  import: { title: 'Import from QuickBooks', subtitle: 'Drop an .iif file to seed your books' },
  reports: { title: 'Reports', subtitle: 'Trial balance, P&L, A/R, A/P, and more' },
  'tax-rates': { title: 'Tax rates', subtitle: 'Sales-tax rates applied to invoices' },
  '1099-prep': { title: '1099 prep', subtitle: 'Year-end NEC + MISC pre-flight' },
  recurring: { title: 'Recurring', subtitle: 'Monthly retainers + recurring bills' },
  'time-entries': { title: 'Time entries', subtitle: 'Worker hours that flow into bills' },
  items: { title: 'Items / services', subtitle: 'Saved fixtures for invoice + bill lines' },
  'payroll-runs': { title: 'Pay runs', subtitle: 'Batch entry for paychecks' },
  'fixed-assets': { title: 'Fixed assets', subtitle: 'Capitalized assets + depreciation' },
  activity: { title: 'Activity log', subtitle: 'Append-only audit trail' },
  documents: { title: 'Documents', subtitle: 'Tax returns, 1099s, receipts, statements' },
};

export function AppShell({ memberships }: { memberships: Membership[] }) {
  const { user } = useAuth();
  const { companyId, setCompanyId } = useCurrentCompany();
  const [view, setView] = useState<View>('dashboard');
  const [showNewCompanyModal, setShowNewCompanyModal] = useState(false);
  // Mobile drawer state. Must be declared up here with the other hooks — a
  // hook below the `!isMember` early return changes the hook count when that
  // flag flips (first-login bootstrap, company pick) and white-screens the app.
  const [drawerOpen, setDrawerOpen] = useState(false);

  const isMember = companyId !== null && memberships.some((m) => m.companyId === companyId);

  // One-time bootstrap. If the user has memberships and nothing stored
  // locally, pick the OLDEST membership (deterministic via /me's orderBy).
  // Runs at most once per mount; never overrides an existing companyId.
  //
  // We deliberately do NOT auto-reconcile a stored companyId that isn't in
  // memberships. That auto-reconcile pattern caused a real cross-tenant leak
  // earlier: when a user clicked "+ New client" and created Hunt Construction,
  // there was a render where memberships still held only [Test] before the
  // /me refetch landed; the reconcile effect fired setCompanyId(testId)
  // mid-flight and pinned every query to Test even after refetch completed.
  // Now: if companyId is invalid for any reason, we show NoActiveCompany
  // and force an explicit pick. Slow path is rare; correctness is absolute.
  const bootstrappedRef = useRef(false);
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    if (companyId === null && memberships.length > 0) {
      setCompanyId(memberships[0]!.companyId);
    }
    // Intentionally empty deps -- this is mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dashboard tiles can ask the shell to navigate to a specific view +
  // optional sub-tab (e.g. "reports:ar-aging"). The colon-separated form is
  // expanded by handleNavigate -- the sub-tab portion is currently dropped
  // (Reports defaults to Trial Balance) but kept in the protocol so future
  // slices can pre-select.
  function handleNavigate(target: string) {
    const [primary] = target.split(':');
    if (primary && (primary in PAGE_META)) {
      setView(primary as View);
    }
  }

  // Components rendered deep in the tree (e.g. Workers detail -> "open 1099
  // prep") can ask the shell to navigate by dispatching a `kpb:navigate` event
  // with the view id as `detail`. Avoids prop-drilling through every tab.
  //
  // This hook MUST stay above the `!isMember` early return: `isMember` flips
  // at runtime (first-login bootstrap, company pick), and a hook that appears
  // only on one side of that flip changes the hook count between renders,
  // which makes React throw and white-screens the app.
  useEffect(() => {
    const handler = (e: Event) => {
      const target = (e as CustomEvent<string>).detail;
      if (typeof target === 'string') handleNavigate(target);
    };
    window.addEventListener('kpb:navigate', handler);
    return () => window.removeEventListener('kpb:navigate', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If we have no valid company selected, force a pick before rendering the
  // app. Covers: never bootstrapped (initial empty localStorage), id revoked,
  // id stale across deploys, or a transient race where memberships hasn't
  // caught up.
  if (!isMember) {
    return (
      <NoActiveCompany
        memberships={memberships}
        onPick={setCompanyId}
        onAddNew={() => setShowNewCompanyModal(true)}
        showNewCompanyModal={showNewCompanyModal}
        onCloseNewCompanyModal={() => setShowNewCompanyModal(false)}
      />
    );
  }

  // From here on, `companyId` is guaranteed to be a valid membership.
  const activeId = companyId;
  const active = memberships.find((m) => m.companyId === activeId);

  const meta = PAGE_META[view];

  // Selecting a sidebar item should also close the mobile drawer (no-op on
  // tablet+ where the sidebar is always visible).
  function selectAndCloseDrawer(v: View) {
    setView(v);
    setDrawerOpen(false);
  }

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Sidebar — visible on tablet+, hidden on mobile (drawer takes over) */}
      <aside className="hidden w-60 shrink-0 sm:block">
        <div className="sticky top-0 h-screen">
          <Sidebar activeView={view} onSelect={setView} />
        </div>
      </aside>

      {/* Mobile drawer — slides in from left when drawerOpen=true */}
      {drawerOpen && (
        <div
          className="kpb-fade-in fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-sm sm:hidden"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      )}
      <div
        className={
          'fixed inset-y-0 left-0 z-50 w-64 transform transition-transform duration-200 ease-out sm:hidden ' +
          (drawerOpen ? 'translate-x-0' : '-translate-x-full')
        }
        role="dialog"
        aria-label="Navigation"
      >
        <Sidebar activeView={view} onSelect={selectAndCloseDrawer} />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur">
          <div className="flex items-center justify-between gap-3 px-3 py-3 sm:gap-4 sm:px-6">
            {/* Mobile-only hamburger */}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-700 hover:bg-slate-100 sm:hidden"
              aria-label="Open navigation"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                className="h-5 w-5"
                aria-hidden
              >
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            </button>

            <div className="flex min-w-0 flex-1 items-center gap-3 sm:gap-4">
              <div className="min-w-0">
                <h1 className="truncate text-base font-semibold tracking-tight text-slate-900">
                  {meta.title}
                </h1>
                {meta.subtitle && (
                  <p className="hidden truncate text-xs text-slate-500 sm:block">
                    {meta.subtitle}
                  </p>
                )}
              </div>
              <span className="hidden h-8 w-px bg-slate-200 sm:block" />
              <CompanyPicker
                memberships={memberships}
                activeId={activeId}
                onChange={setCompanyId}
                onAddNew={() => setShowNewCompanyModal(true)}
                activeRole={active?.role}
              />
            </div>
            <UserMenu email={user?.email ?? null} />
          </div>
        </header>

        {showNewCompanyModal && <NewCompanyModal onClose={() => setShowNewCompanyModal(false)} />}

        <main className="flex-1 overflow-y-auto px-3 py-4 sm:px-6 sm:py-6">
          <div className="mx-auto max-w-6xl space-y-6">
            {view === 'dashboard' && <Dashboard onNavigate={handleNavigate} />}
            {view === 'chat' && <Chat />}
            {view === 'accounts' && <AccountsList />}
            {view === 'customers' && <CustomersList />}
            {view === 'estimates' && <EstimatesList />}
            {view === 'vendors' && <VendorsList />}
            {view === 'invoices' && <InvoicesList />}
            {view === 'items' && <ItemsList />}
            {view === 'bills' && <BillsList />}
            {view === 'payments' && <PaymentsList />}
            {view === 'banking' && <BankingList />}
            {view === 'mileage' && <Mileage />}
            {view === 'workers' && <Workers />}
            {view === 'new-entry' && <JournalEntryForm />}
            {view === 'recurring' && <Recurring />}
            {view === 'time-entries' && <TimeEntries />}
            {view === 'payroll-runs' && <PayrollRuns />}
            {view === 'fixed-assets' && <FixedAssets />}
            {view === 'reports' && <Reports />}
            {view === 'activity' && <Activity />}
            {view === 'documents' && <Documents />}
            {view === 'tax-rates' && <TaxRates />}
            {view === '1099-prep' && <NinetyNinePrep />}
            {view === 'import' && <Imports />}
            <ReadyzSelfTest />
          </div>
        </main>
      </div>
    </div>
  );
}

/**
 * Fallback screen shown when no valid company is selected (no membership
 * matches the stored id). Forces an explicit pick rather than silently
 * snapping to a different tenant -- the snap-back was the cross-tenant
 * leak we fixed; this screen makes the bad state visible instead.
 */
function NoActiveCompany({
  memberships,
  onPick,
  onAddNew,
  showNewCompanyModal,
  onCloseNewCompanyModal,
}: {
  memberships: Membership[];
  onPick: (id: string) => void;
  onAddNew: () => void;
  showNewCompanyModal: boolean;
  onCloseNewCompanyModal: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-100 via-slate-50 to-emerald-50/30 p-6">
      <div className="kpb-pop-in w-full max-w-md space-y-5 rounded-xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-900/5">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-emerald-600 text-slate-950 shadow-sm">
            <Icon name="circle-dollar" className="h-6 w-6" strokeWidth={2.25} />
          </div>
          <div>
            <div className="text-lg font-semibold tracking-tight text-slate-900">KPBooks</div>
            <div className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
              Accounting · simplified
            </div>
          </div>
        </div>

        <div>
          <h2 className="text-base font-medium text-slate-900">
            {memberships.length === 0
              ? 'Welcome — add your first client to get started'
              : 'Pick a client to continue'}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {memberships.length === 0
              ? "We'll create a fresh chart of accounts and let you import an existing QuickBooks .iif file once the company exists."
              : 'Each client has its own books, COA, and history. Switch any time from the dropdown in the page header.'}
          </p>
        </div>

        {memberships.length > 0 && (
          <ul className="space-y-1.5">
            {memberships.map((m) => {
              const initials =
                m.companyName
                  .split(/\s+/)
                  .filter(Boolean)
                  .slice(0, 2)
                  .map((w) => w[0]?.toUpperCase() ?? '')
                  .join('') || '?';
              return (
                <li key={m.companyId}>
                  <button
                    type="button"
                    onClick={() => onPick(m.companyId)}
                    className="group flex w-full items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2.5 text-left text-sm transition-all hover:-translate-y-px hover:border-slate-400 hover:bg-slate-50 hover:shadow-sm"
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-slate-700 to-slate-900 text-[11px] font-semibold text-white">
                      {initials}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-slate-900">{m.companyName}</div>
                      <div className="text-[11px] uppercase tracking-wider text-slate-400">
                        {m.role}
                      </div>
                    </div>
                    <Icon
                      name="arrow-right"
                      className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-slate-700"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <button
          type="button"
          onClick={onAddNew}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-600 transition-colors hover:border-slate-400 hover:bg-slate-50 hover:text-slate-900"
        >
          <Icon name="plus" className="h-4 w-4" strokeWidth={2.25} />
          Add a new client
        </button>
      </div>
      {showNewCompanyModal && <NewCompanyModal onClose={onCloseNewCompanyModal} />}
    </div>
  );
}

function CompanyPicker({
  memberships,
  activeId,
  onChange,
  onAddNew,
  activeRole,
}: {
  memberships: Membership[];
  activeId: string | null;
  onChange: (id: string) => void;
  onAddNew: () => void;
  activeRole: Membership['role'] | undefined;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = memberships.find((m) => m.companyId === activeId);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initials = (active?.companyName ?? '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={
          'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm transition-colors ' +
          (open
            ? 'border-slate-400 bg-slate-50'
            : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50')
        }
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded bg-gradient-to-br from-slate-700 to-slate-900 text-[10px] font-semibold text-white">
          {initials}
        </span>
        <span className="max-w-[16ch] truncate font-medium text-slate-900">
          {active?.companyName ?? 'Pick a client'}
        </span>
        {activeRole && (
          <span className="hidden rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-500 sm:inline">
            {activeRole}
          </span>
        )}
        <Icon
          name="chevron-down"
          className={'h-3.5 w-3.5 text-slate-400 transition-transform ' + (open ? 'rotate-180' : '')}
        />
      </button>
      {open && (
        <div
          className="absolute left-0 top-full z-40 mt-1 w-72 overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg"
          role="listbox"
        >
          <div className="max-h-72 overflow-y-auto py-1">
            {memberships.map((m) => {
              const isActive = m.companyId === activeId;
              return (
                <button
                  key={m.companyId}
                  type="button"
                  onClick={() => {
                    onChange(m.companyId);
                    setOpen(false);
                  }}
                  className={
                    'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-slate-50 ' +
                    (isActive ? 'bg-emerald-50/40' : '')
                  }
                  role="option"
                  aria-selected={isActive}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-slate-900">{m.companyName}</div>
                    <div className="text-[11px] uppercase tracking-wider text-slate-400">
                      {m.role}
                    </div>
                  </div>
                  {isActive && (
                    <Icon name="check" className="h-4 w-4 shrink-0 text-emerald-600" strokeWidth={2.25} />
                  )}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => {
              onAddNew();
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 border-t border-slate-200 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
          >
            <Icon name="plus" className="h-4 w-4" strokeWidth={2.25} />
            New client
          </button>
        </div>
      )}
    </div>
  );
}

function UserMenu({ email }: { email: string | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const initial = email ? email[0]?.toUpperCase() ?? '?' : '?';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-slate-700 to-slate-900 text-sm font-semibold text-white shadow-sm transition-transform hover:scale-105"
        aria-haspopup="menu"
        aria-expanded={open}
        title={email ?? ''}
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-60 overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg">
          <div className="border-b border-slate-200 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              Signed in as
            </div>
            <div className="truncate text-sm text-slate-900">{email ?? '—'}</div>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            <Icon name="log-out" className="h-4 w-4 text-slate-400" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

function NewCompanyModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="kpb-fade-in fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="kpb-pop-in w-full max-w-md space-y-5 rounded-lg border border-slate-200 bg-white p-6 shadow-xl shadow-slate-900/10">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-slate-900">New client</h2>
            <p className="text-xs text-slate-500">
              Adds a new company you'll be the owner of, with its own seeded chart of accounts.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>
        <NewCompanyForm onCreated={() => onClose()} />
      </div>
    </div>
  );
}

function ReadyzSelfTest() {
  const query = useQuery({
    queryKey: ['readyz'],
    queryFn: () => api<{ ok: boolean }>('/readyz'),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  return (
    <footer className="border-t border-slate-200 pt-4 text-xs text-slate-500">
      API status:{' '}
      {query.isLoading
        ? 'checking…'
        : query.data?.ok
          ? '✓ live (Cloud Run + Neon Postgres)'
          : '✗ unreachable'}
    </footer>
  );
}
