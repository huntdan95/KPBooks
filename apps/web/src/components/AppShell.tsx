import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { LanguageSwitcher } from './LanguageSwitcher';
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

/**
 * Page chrome per view. Stored as i18n keys rather than literals: this map
 * lives at module scope where hooks can't run, so AppShell resolves each key
 * through t() at render time. It doubles as the allow-list of navigable
 * views (see handleNavigate), so every View id must appear here.
 */
const PAGE_META: Record<View, { titleKey: string; subtitleKey?: string }> = {
  dashboard: { titleKey: 'pages.dashboard.title', subtitleKey: 'pages.dashboard.subtitle' },
  chat: { titleKey: 'pages.chat.title', subtitleKey: 'pages.chat.subtitle' },
  estimates: { titleKey: 'pages.estimates.title', subtitleKey: 'pages.estimates.subtitle' },
  invoices: { titleKey: 'pages.invoices.title', subtitleKey: 'pages.invoices.subtitle' },
  customers: { titleKey: 'pages.customers.title', subtitleKey: 'pages.customers.subtitle' },
  bills: { titleKey: 'pages.bills.title', subtitleKey: 'pages.bills.subtitle' },
  vendors: { titleKey: 'pages.vendors.title', subtitleKey: 'pages.vendors.subtitle' },
  mileage: { titleKey: 'pages.mileage.title', subtitleKey: 'pages.mileage.subtitle' },
  workers: { titleKey: 'pages.workers.title', subtitleKey: 'pages.workers.subtitle' },
  banking: { titleKey: 'pages.banking.title', subtitleKey: 'pages.banking.subtitle' },
  payments: { titleKey: 'pages.payments.title', subtitleKey: 'pages.payments.subtitle' },
  accounts: { titleKey: 'pages.accounts.title', subtitleKey: 'pages.accounts.subtitle' },
  'new-entry': { titleKey: 'pages.new-entry.title', subtitleKey: 'pages.new-entry.subtitle' },
  import: { titleKey: 'pages.import.title', subtitleKey: 'pages.import.subtitle' },
  reports: { titleKey: 'pages.reports.title', subtitleKey: 'pages.reports.subtitle' },
  'tax-rates': { titleKey: 'pages.tax-rates.title', subtitleKey: 'pages.tax-rates.subtitle' },
  '1099-prep': { titleKey: 'pages.1099-prep.title', subtitleKey: 'pages.1099-prep.subtitle' },
  recurring: { titleKey: 'pages.recurring.title', subtitleKey: 'pages.recurring.subtitle' },
  'time-entries': { titleKey: 'pages.time-entries.title', subtitleKey: 'pages.time-entries.subtitle' },
  items: { titleKey: 'pages.items.title', subtitleKey: 'pages.items.subtitle' },
  'payroll-runs': { titleKey: 'pages.payroll-runs.title', subtitleKey: 'pages.payroll-runs.subtitle' },
  'fixed-assets': { titleKey: 'pages.fixed-assets.title', subtitleKey: 'pages.fixed-assets.subtitle' },
  activity: { titleKey: 'pages.activity.title', subtitleKey: 'pages.activity.subtitle' },
  documents: { titleKey: 'pages.documents.title', subtitleKey: 'pages.documents.subtitle' },
};

export function AppShell({ memberships }: { memberships: Membership[] }) {
  const { t } = useTranslation(['shell', 'common']);
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
          'fixed inset-y-0 left-0 z-50 flex w-64 transform flex-col transition-transform duration-200 ease-out sm:hidden ' +
          (drawerOpen ? 'translate-x-0' : '-translate-x-full')
        }
        role="dialog"
        aria-label={t('header.navigation')}
      >
        <div className="min-h-0 flex-1">
          <Sidebar activeView={view} onSelect={selectAndCloseDrawer} />
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-800 bg-slate-950 px-3 py-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
            {t('common:language')}
          </span>
          <LanguageSwitcher compact />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur">
          <div className="flex items-center justify-between gap-3 px-3 py-3 sm:gap-4 sm:px-6">
            {/* Mobile-only hamburger */}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-slate-200 text-slate-700 hover:bg-slate-100 sm:hidden"
              aria-label={t('header.openNavigation')}
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
                  {t(meta.titleKey)}
                </h1>
                {meta.subtitleKey && (
                  <p className="hidden truncate text-xs text-slate-500 sm:block">
                    {t(meta.subtitleKey)}
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
            <div className="flex shrink-0 items-center gap-2 sm:gap-3">
              {/* Desktop language toggle — on mobile it lives in the drawer */}
              <div className="hidden sm:block">
                <LanguageSwitcher compact />
              </div>
              <UserMenu email={user?.email ?? null} />
            </div>
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
  const { t } = useTranslation('shell');

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
              {t('brand.tagline')}
            </div>
          </div>
        </div>

        <div>
          <h2 className="text-base font-medium text-slate-900">
            {memberships.length === 0
              ? t('noCompany.welcomeTitle')
              : t('noCompany.pickTitle')}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {memberships.length === 0
              ? t('noCompany.welcomeBody')
              : t('noCompany.pickBody')}
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
                        {t(`roles.${m.role}`)}
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
          {t('noCompany.addNew')}
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
  const { t } = useTranslation('shell');
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
          {active?.companyName ?? t('companyPicker.pick')}
        </span>
        {activeRole && (
          <span className="hidden rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-500 sm:inline">
            {t(`roles.${activeRole}`)}
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
                      {t(`roles.${m.role}`)}
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
            {t('companyPicker.newClient')}
          </button>
        </div>
      )}
    </div>
  );
}

function UserMenu({ email }: { email: string | null }) {
  const { t } = useTranslation(['shell', 'common']);
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
              {t('userMenu.signedInAs')}
            </div>
            <div className="truncate text-sm text-slate-900">{email ?? '—'}</div>
          </div>
          <button
            type="button"
            onClick={() => void signOut()}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
          >
            <Icon name="log-out" className="h-4 w-4 text-slate-400" />
            {t('common:signOut')}
          </button>
        </div>
      )}
    </div>
  );
}

function NewCompanyModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(['shell', 'common']);

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
            <h2 className="text-lg font-semibold tracking-tight text-slate-900">
              {t('newCompanyModal.title')}
            </h2>
            <p className="text-xs text-slate-500">{t('newCompanyModal.description')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common:close')}
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
  const { t } = useTranslation('shell');
  const query = useQuery({
    queryKey: ['readyz'],
    queryFn: () => api<{ ok: boolean }>('/readyz'),
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });

  return (
    <footer className="border-t border-slate-200 pt-4 text-xs text-slate-500">
      {t('readyz.label')}{' '}
      {query.isLoading
        ? t('readyz.checking')
        : query.data?.ok
          ? t('readyz.live')
          : t('readyz.unreachable')}
    </footer>
  );
}
