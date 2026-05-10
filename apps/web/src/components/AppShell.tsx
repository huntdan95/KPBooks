import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { signOut } from '../lib/firebase';
import { useAuth } from '../lib/auth';
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

const PAGE_TITLE: Record<View, string> = {
  dashboard: 'Dashboard',
  chat: 'Ask Claude',
  estimates: 'Estimates',
  invoices: 'Invoices',
  customers: 'Customers',
  bills: 'Bills',
  vendors: 'Vendors',
  mileage: 'Mileage',
  workers: 'Workers / 1099',
  banking: 'Banking',
  payments: 'Payments',
  accounts: 'Chart of Accounts',
  'new-entry': 'New Journal Entry',
  import: 'Import from QuickBooks',
  reports: 'Reports',
  'tax-rates': 'Tax Rates',
  '1099-prep': '1099 Prep',
  recurring: 'Recurring',
  'time-entries': 'Time Entries',
  items: 'Items / Services',
  'payroll-runs': 'Pay Runs',
  'fixed-assets': 'Fixed Assets',
};

export function AppShell({ memberships }: { memberships: Membership[] }) {
  const { user } = useAuth();
  const { companyId, setCompanyId } = useCurrentCompany();
  const [view, setView] = useState<View>('dashboard');
  const [showNewCompanyModal, setShowNewCompanyModal] = useState(false);

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

  // Dashboard tiles can ask the shell to navigate to a specific view +
  // optional sub-tab (e.g. "reports:ar-aging"). The colon-separated form is
  // expanded by handleNavigate -- the sub-tab portion is currently dropped
  // (Reports defaults to Trial Balance) but kept in the protocol so future
  // slices can pre-select.
  function handleNavigate(target: string) {
    const [primary] = target.split(':');
    if (primary && (primary in PAGE_TITLE)) {
      setView(primary as View);
    }
  }

  // Components rendered deep in the tree (e.g. Workers detail -> "open 1099
  // prep") can ask the shell to navigate by dispatching a `kpb:navigate` event
  // with the view id as `detail`. Avoids prop-drilling through every tab.
  useEffect(() => {
    const handler = (e: Event) => {
      const target = (e as CustomEvent<string>).detail;
      if (typeof target === 'string') handleNavigate(target);
    };
    window.addEventListener('kpb:navigate', handler);
    return () => window.removeEventListener('kpb:navigate', handler);
  }, []);

  return (
    <div className="flex min-h-screen bg-slate-100">
      <aside className="hidden w-56 shrink-0 sm:block">
        <div className="sticky top-0 h-screen">
          <Sidebar activeView={view} onSelect={setView} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-slate-200 bg-white">
          <div className="flex items-center justify-between px-6 py-3">
            <div className="flex items-center gap-4">
              <h1 className="text-base font-semibold tracking-tight text-slate-900">
                {PAGE_TITLE[view]}
              </h1>
              <CompanyPicker
                memberships={memberships}
                activeId={activeId}
                onChange={setCompanyId}
                onAddNew={() => setShowNewCompanyModal(true)}
              />
            </div>
            <div className="flex items-center gap-3 text-sm text-slate-600">
              {active && (
                <span className="hidden sm:inline">
                  <span className="text-slate-400">role:</span>{' '}
                  <span className="font-medium text-slate-900">{active.role}</span>
                </span>
              )}
              <span>{user?.email}</span>
              <button
                type="button"
                onClick={() => void signOut()}
                className="rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-100"
              >
                Sign out
              </button>
            </div>
          </div>
        </header>

        {showNewCompanyModal && <NewCompanyModal onClose={() => setShowNewCompanyModal(false)} />}

        <main className="flex-1 overflow-y-auto px-6 py-6">
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
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-6">
      <div className="w-full max-w-md space-y-5 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <div className="text-lg font-semibold tracking-tight text-slate-900">KPBooks</div>
          <h2 className="mt-2 text-base font-medium text-slate-900">Pick a client to continue</h2>
          <p className="mt-1 text-xs text-slate-500">
            Each client has its own books, COA, and history. Switch any time from the dropdown
            in the page header.
          </p>
        </div>
        <ul className="space-y-1.5">
          {memberships.map((m) => (
            <li key={m.companyId}>
              <button
                type="button"
                onClick={() => onPick(m.companyId)}
                className="flex w-full items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-left text-sm hover:border-slate-400 hover:bg-slate-50"
              >
                <span className="font-medium text-slate-900">{m.companyName}</span>
                <span className="text-xs text-slate-500">{m.role}</span>
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={onAddNew}
          className="w-full rounded-md border border-dashed border-slate-300 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
        >
          + Add a new client
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
}: {
  memberships: Membership[];
  activeId: string | null;
  onChange: (id: string) => void;
  onAddNew: () => void;
}) {
  return (
    <select
      value={activeId ?? ''}
      onChange={(e) => {
        if (e.target.value === '__new__') {
          onAddNew();
        } else {
          onChange(e.target.value);
        }
      }}
      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-slate-900 focus:outline-none"
    >
      {memberships.map((m) => (
        <option key={m.companyId} value={m.companyId}>
          {m.companyName}
        </option>
      ))}
      <option disabled>──────────</option>
      <option value="__new__">+ New client…</option>
    </select>
  );
}

function NewCompanyModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-md space-y-5 rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
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
