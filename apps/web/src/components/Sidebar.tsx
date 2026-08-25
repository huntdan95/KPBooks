/**
 * Left-rail navigation, QuickBooks-Online style. Sections group related
 * pages; click a leaf to switch the active view in AppShell. The active
 * pill is rendered inline rather than relying on URL state because the
 * app is currently single-route SPA (no router).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  | 'activity'
  | 'documents';

/**
 * Labels are stored as i18n keys (not literals) because SECTIONS lives at
 * module scope where hooks can't run -- the Sidebar component resolves each
 * key through t() at render time so a language switch re-labels the rail.
 */
interface NavItem {
  id: View;
  labelKey: string;
  icon: IconName;
}

interface NavSection {
  labelKey: string | null;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    labelKey: null,
    items: [
      { id: 'dashboard', labelKey: 'nav.items.dashboard', icon: 'dashboard' },
      { id: 'chat', labelKey: 'nav.items.chat', icon: 'sparkles' },
    ],
  },
  {
    labelKey: 'nav.sections.sales',
    items: [
      { id: 'estimates', labelKey: 'nav.items.estimates', icon: 'file-text' },
      { id: 'invoices', labelKey: 'nav.items.invoices', icon: 'file-stack' },
      { id: 'customers', labelKey: 'nav.items.customers', icon: 'users' },
      { id: 'items', labelKey: 'nav.items.items', icon: 'package' },
      { id: 'payments', labelKey: 'nav.items.payments', icon: 'credit-card' },
    ],
  },
  {
    labelKey: 'nav.sections.expenses',
    items: [
      { id: 'bills', labelKey: 'nav.items.bills', icon: 'receipt' },
      { id: 'vendors', labelKey: 'nav.items.vendors', icon: 'building-2' },
      { id: 'mileage', labelKey: 'nav.items.mileage', icon: 'car' },
    ],
  },
  {
    labelKey: 'nav.sections.workers',
    items: [
      { id: 'workers', labelKey: 'nav.items.workers', icon: 'briefcase' },
      { id: 'time-entries', labelKey: 'nav.items.time-entries', icon: 'clock' },
      { id: 'payroll-runs', labelKey: 'nav.items.payroll-runs', icon: 'wallet' },
    ],
  },
  {
    labelKey: 'nav.sections.accounting',
    items: [
      { id: 'accounts', labelKey: 'nav.items.accounts', icon: 'book-open' },
      { id: 'banking', labelKey: 'nav.items.banking', icon: 'banknote' },
      { id: 'new-entry', labelKey: 'nav.items.new-entry', icon: 'plus-square' },
      { id: 'recurring', labelKey: 'nav.items.recurring', icon: 'repeat' },
      { id: 'fixed-assets', labelKey: 'nav.items.fixed-assets', icon: 'truck' },
      { id: 'import', labelKey: 'nav.items.import', icon: 'upload-cloud' },
    ],
  },
  {
    labelKey: 'nav.sections.reports',
    items: [
      { id: 'reports', labelKey: 'nav.items.reports', icon: 'bar-chart' },
      { id: 'activity', labelKey: 'nav.items.activity', icon: 'history' },
      { id: 'documents', labelKey: 'nav.items.documents', icon: 'file-stack' },
    ],
  },
  {
    labelKey: 'nav.sections.taxes',
    items: [
      { id: 'tax-rates', labelKey: 'nav.items.tax-rates', icon: 'percent' },
      { id: '1099-prep', labelKey: 'nav.items.1099-prep', icon: 'badge-check' },
    ],
  },
];

const COLLAPSE_KEY = 'kpb:nav-collapsed';

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    // Private-mode or corrupted value: start expanded rather than blowing up.
    return new Set();
  }
}
export function Sidebar({
  activeView,
  onSelect,
}: {
  activeView: View;
  onSelect: (v: View) => void;
}) {
  const { t } = useTranslation('shell');
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);

  function toggleSection(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      } catch {
        // Not worth failing a click over; the rail just forgets next reload.
      }
      return next;
    });
  }

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
            {t('brand.tagline')}
          </div>
        </div>
      </div>

      {SECTIONS.map((section, sIdx) => {
        const key = section.labelKey ?? `section-${sIdx}`;
        // The section holding the current page always stays open, so
        // navigating from somewhere else (a dashboard tile, the 1099 page)
        // can never land the user on a highlighted item they cannot see.
        const holdsActive = section.items.some((i) => i.id === activeView);
        const isCollapsed = section.labelKey !== null && collapsed.has(key) && !holdsActive;
        return (
          <div key={sIdx} className="mb-1">
            {section.labelKey && (
              <button
                type="button"
                onClick={() => toggleSection(key)}
                aria-expanded={!isCollapsed}
                className="flex w-full items-center gap-1 rounded px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500 transition-colors hover:text-slate-300"
              >
                <Icon
                  name={isCollapsed ? 'chevron-right' : 'chevron-down'}
                  className="h-3 w-3 shrink-0"
                />
                <span>{t(section.labelKey)}</span>
              </button>
            )}
            {!isCollapsed && (
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
                    <span className={isActive ? 'font-medium' : ''}>{t(item.labelKey)}</span>
                  </button>
                </li>
              );
            })}
            </ul>
            )}
          </div>
        );
      })}

      {/* Footer */}
      <div className="mt-auto pt-4">
        <div className="mx-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-[10px] leading-relaxed text-slate-500">
          <span className="text-slate-400">{t('nav.tip.label')}</span> {t('nav.tip.text')}
        </div>
      </div>
    </nav>
  );
}
