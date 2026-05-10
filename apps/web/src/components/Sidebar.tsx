/**
 * Left-rail navigation, QuickBooks-Online style. Sections group related
 * pages; click a leaf to switch the active view in AppShell. The active
 * pill is rendered inline rather than relying on URL state because the
 * app is currently single-route SPA (no router).
 */

import { Icon, type IconName } from './ui/Icon';

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
  | 'fixed-assets'
  | 'activity';

interface NavItem {
  id: View;
  label: string;
  icon: IconName;
}

interface NavSection {
  label: string | null;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    label: null,
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
      { id: 'chat', label: 'Ask Claude', icon: 'sparkles' },
    ],
  },
  {
    label: 'Sales',
    items: [
      { id: 'estimates', label: 'Estimates', icon: 'file-text' },
      { id: 'invoices', label: 'Invoices', icon: 'file-stack' },
      { id: 'customers', label: 'Customers', icon: 'users' },
      { id: 'items', label: 'Items / services', icon: 'package' },
      { id: 'payments', label: 'Payments', icon: 'credit-card' },
    ],
  },
  {
    label: 'Expenses',
    items: [
      { id: 'bills', label: 'Bills', icon: 'receipt' },
      { id: 'vendors', label: 'Vendors', icon: 'building-2' },
      { id: 'mileage', label: 'Mileage', icon: 'car' },
    ],
  },
  {
    label: 'Workers',
    items: [
      { id: 'workers', label: 'Workers / 1099', icon: 'briefcase' },
      { id: 'time-entries', label: 'Time entries', icon: 'clock' },
      { id: 'payroll-runs', label: 'Pay runs', icon: 'wallet' },
    ],
  },
  {
    label: 'Banking',
    items: [{ id: 'banking', label: 'Bank accounts', icon: 'banknote' }],
  },
  {
    label: 'Accounting',
    items: [
      { id: 'accounts', label: 'Chart of accounts', icon: 'book-open' },
      { id: 'new-entry', label: 'New journal entry', icon: 'plus-square' },
      { id: 'recurring', label: 'Recurring', icon: 'repeat' },
      { id: 'fixed-assets', label: 'Fixed assets', icon: 'truck' },
      { id: 'import', label: 'Import (.iif)', icon: 'upload-cloud' },
    ],
  },
  {
    label: 'Reports',
    items: [
      { id: 'reports', label: 'All reports', icon: 'bar-chart' },
      { id: 'activity', label: 'Activity log', icon: 'history' },
    ],
  },
  {
    label: 'Taxes',
    items: [
      { id: 'tax-rates', label: 'Tax rates', icon: 'percent' },
      { id: '1099-prep', label: '1099 prep', icon: 'badge-check' },
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
    <nav className="flex h-full flex-col overflow-y-auto bg-gradient-to-b from-slate-900 to-slate-950 px-3 py-4 text-sm text-slate-200">
      {/* Brand */}
      <div className="mb-5 flex items-center gap-2 px-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-emerald-400 to-emerald-600 text-slate-950 shadow-sm">
          <Icon name="circle-dollar" className="h-5 w-5" strokeWidth={2.25} />
        </div>
        <div>
          <div className="text-base font-semibold tracking-tight text-white leading-tight">
            KPBooks
          </div>
          <div className="text-[10px] uppercase tracking-[0.14em] text-slate-500">
            Accounting · simplified
          </div>
        </div>
      </div>

      {SECTIONS.map((section, sIdx) => (
        <div key={sIdx} className="mb-1">
          {section.label && (
            <div className="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              {section.label}
            </div>
          )}
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const isActive = item.id === activeView;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(item.id)}
                    className={
                      'group relative flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] transition-all duration-150 ' +
                      (isActive
                        ? 'bg-emerald-500/15 text-white shadow-[inset_0_0_0_1px_rgba(16,185,129,0.25)]'
                        : 'text-slate-400 hover:bg-slate-800/60 hover:text-white')
                    }
                  >
                    {isActive && (
                      <span
                        aria-hidden
                        className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-emerald-400"
                      />
                    )}
                    <Icon
                      name={item.icon}
                      className={
                        'h-[15px] w-[15px] shrink-0 transition-colors ' +
                        (isActive ? 'text-emerald-300' : 'text-slate-500 group-hover:text-slate-300')
                      }
                    />
                    <span className={isActive ? 'font-medium' : ''}>{item.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {/* Footer */}
      <div className="mt-auto pt-4">
        <div className="mx-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-[10px] leading-relaxed text-slate-500">
          <span className="text-slate-400">Tip:</span> the dashboard surfaces overdue A/R + A/P and any subcontractor docs expiring soon.
        </div>
      </div>
    </nav>
  );
}
