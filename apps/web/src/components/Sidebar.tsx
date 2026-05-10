/**
 * Left-rail navigation, QuickBooks-Online style. Sections group related
 * pages; click a leaf to switch the active view in AppShell. The active
 * pill is rendered inline rather than relying on URL state because the
 * app is currently single-route SPA (no router).
 */

export type View =
  | 'dashboard'
  | 'chat'
  | 'estimates'
  | 'invoices'
  | 'customers'
  | 'bills'
  | 'vendors'
  | 'mileage'
  | 'workers'
  | 'banking'
  | 'payments'
  | 'accounts'
  | 'new-entry'
  | 'import'
  | 'reports'
  | 'tax-rates'
  | '1099-prep'
  | 'recurring'
  | 'time-entries'
  | 'items'
  | 'payroll-runs'
  | 'fixed-assets';

interface NavItem {
  id: View;
  label: string;
}

interface NavSection {
  label: string | null;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    label: null,
    items: [
      { id: 'dashboard', label: 'Dashboard' },
      { id: 'chat', label: 'Ask Claude' },
    ],
  },
  {
    label: 'Sales',
    items: [
      { id: 'estimates', label: 'Estimates' },
      { id: 'invoices', label: 'Invoices' },
      { id: 'customers', label: 'Customers' },
      { id: 'items', label: 'Items / services' },
      { id: 'payments', label: 'Payments' },
    ],
  },
  {
    label: 'Expenses',
    items: [
      { id: 'bills', label: 'Bills' },
      { id: 'vendors', label: 'Vendors' },
      { id: 'mileage', label: 'Mileage' },
    ],
  },
  {
    label: 'Workers',
    items: [
      { id: 'workers', label: 'Workers / 1099' },
      { id: 'time-entries', label: 'Time entries' },
      { id: 'payroll-runs', label: 'Pay runs' },
    ],
  },
  {
    label: 'Banking',
    items: [{ id: 'banking', label: 'Bank accounts' }],
  },
  {
    label: 'Accounting',
    items: [
      { id: 'accounts', label: 'Chart of accounts' },
      { id: 'new-entry', label: 'New journal entry' },
      { id: 'recurring', label: 'Recurring' },
      { id: 'fixed-assets', label: 'Fixed assets' },
      { id: 'import', label: 'Import (.iif)' },
    ],
  },
  {
    label: 'Reports',
    items: [{ id: 'reports', label: 'All reports' }],
  },
  {
    label: 'Taxes',
    items: [
      { id: 'tax-rates', label: 'Tax rates' },
      { id: '1099-prep', label: '1099 prep' },
    ],
  },
];

export function Sidebar({
  activeView,
  onSelect,
}: {
  activeView: View;
  onSelect: (v: View) => void;
}) {
  return (
    <nav className="h-full overflow-y-auto bg-slate-900 px-2 py-4 text-sm text-slate-200">
      <div className="mb-4 px-3">
        <div className="text-lg font-semibold tracking-tight text-white">KPBooks</div>
        <div className="text-xs text-slate-400">Accounting · made simple</div>
      </div>

      {SECTIONS.map((section, sIdx) => (
        <div key={sIdx} className="mb-1">
          {section.label && (
            <div className="px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wider text-slate-500">
              {section.label}
            </div>
          )}
          <ul>
            {section.items.map((item) => {
              const isActive = item.id === activeView;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(item.id)}
                    className={
                      'w-full rounded-md px-3 py-1.5 text-left text-sm transition-colors ' +
                      (isActive
                        ? 'bg-emerald-600/20 text-white font-medium'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white')
                    }
                  >
                    {item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
