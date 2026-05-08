import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { signOut } from '../lib/firebase';
import { useAuth } from '../lib/auth';
import { AccountsList } from './AccountsList';
import { CustomersList } from './CustomersList';
import { JournalEntryForm } from './JournalEntryForm';
import { TrialBalance } from './TrialBalance';
import { VendorsList } from './VendorsList';

interface Membership {
  companyId: string;
  companyName: string;
  role: 'owner' | 'admin' | 'bookkeeper' | 'viewer';
}

type View = 'accounts' | 'customers' | 'vendors' | 'new-entry' | 'trial-balance';

const TABS: ReadonlyArray<{ id: View; label: string }> = [
  { id: 'accounts', label: 'Chart of Accounts' },
  { id: 'customers', label: 'Customers' },
  { id: 'vendors', label: 'Vendors' },
  { id: 'new-entry', label: 'New Entry' },
  { id: 'trial-balance', label: 'Trial Balance' },
];

export function AppShell({ memberships }: { memberships: Membership[] }) {
  const { user } = useAuth();
  const { companyId, setCompanyId } = useCurrentCompany();
  const [view, setView] = useState<View>('accounts');

  // If the stored companyId isn't in the user's memberships (e.g. revoked),
  // fall back to the first available company.
  const activeId =
    companyId && memberships.some((m) => m.companyId === companyId)
      ? companyId
      : memberships[0]?.companyId ?? null;

  if (activeId !== companyId) {
    setCompanyId(activeId);
  }

  const active = memberships.find((m) => m.companyId === activeId);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-4">
            <h1 className="text-lg font-semibold tracking-tight text-slate-900">KPBooks</h1>
            <CompanyPicker
              memberships={memberships}
              activeId={activeId}
              onChange={setCompanyId}
            />
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-600">
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
        <nav className="mx-auto flex max-w-5xl gap-1 px-6">
          {TABS.map((tab) => {
            const isActive = view === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setView(tab.id)}
                className={
                  'border-b-2 px-3 py-2 text-sm transition-colors ' +
                  (isActive
                    ? 'border-slate-900 font-medium text-slate-900'
                    : 'border-transparent text-slate-500 hover:text-slate-800')
                }
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl space-y-6 px-6 py-6">
        {active && (
          <div className="text-sm text-slate-600">
            Viewing <span className="font-medium text-slate-900">{active.companyName}</span> as{' '}
            <span className="font-medium text-slate-900">{active.role}</span>.
          </div>
        )}
        {view === 'accounts' && <AccountsList />}
        {view === 'customers' && <CustomersList />}
        {view === 'vendors' && <VendorsList />}
        {view === 'new-entry' && <JournalEntryForm />}
        {view === 'trial-balance' && <TrialBalance />}
        <ReadyzSelfTest />
      </main>
    </div>
  );
}

function CompanyPicker({
  memberships,
  activeId,
  onChange,
}: {
  memberships: Membership[];
  activeId: string | null;
  onChange: (id: string) => void;
}) {
  return (
    <select
      value={activeId ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-slate-900 focus:outline-none"
    >
      {memberships.map((m) => (
        <option key={m.companyId} value={m.companyId}>
          {m.companyName}
        </option>
      ))}
    </select>
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
