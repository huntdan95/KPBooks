import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
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
  workers: 'Workers',
  banking: 'Banking',
  payments: 'Payments',
  accounts: 'Chart of Accounts',
  'new-entry': 'New Journal Entry',
  import: 'Import from QuickBooks',
  reports: 'Reports',
  'tax-rates': 'Tax Rates',
  '1099-prep': '1099 Prep',
};

export function AppShell({ memberships }: { memberships: Membership[] }) {
  const { user } = useAuth();
  const { companyId, setCompanyId } = useCurrentCompany();
  const [view, setView] = useState<View>('dashboard');
  const [showNewCompanyModal, setShowNewCompanyModal] = useState(false);

  // If the stored companyId isn't in the user's memberships (e.g. revoked,
  // or stored id stale before /me refetched), fall back to the first available
  // company. Done in an effect, NOT during render -- otherwise a freshly-created
  // company id gets overwritten before the /me query has caught up with the
  // new membership, which causes the picker to snap back to the original client.
  const isMember = companyId !== null && memberships.some((m) => m.companyId === companyId);
  const activeId = isMember ? companyId : memberships[0]?.companyId ?? null;

  useEffect(() => {
    if (!isMember && activeId !== companyId) {
      setCompanyId(activeId);
    }
  }, [isMember, activeId, companyId, setCompanyId]);

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
            {view === 'bills' && <BillsList />}
            {view === 'payments' && <PaymentsList />}
            {view === 'banking' && <BankingList />}
            {view === 'mileage' && <Mileage />}
            {view === 'workers' && <Workers />}
            {view === 'new-entry' && <JournalEntryForm />}
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
