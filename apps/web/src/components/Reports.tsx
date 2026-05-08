import { useState } from 'react';
import { Aging } from './Aging';
import { BalanceSheet } from './BalanceSheet';
import { ProfitAndLoss } from './ProfitAndLoss';
import { TrialBalance } from './TrialBalance';

type ReportView = 'trial-balance' | 'pnl' | 'balance-sheet' | 'ar-aging' | 'ap-aging';

const SUB_TABS: ReadonlyArray<{ id: ReportView; label: string }> = [
  { id: 'trial-balance', label: 'Trial Balance' },
  { id: 'pnl', label: 'Profit & Loss' },
  { id: 'balance-sheet', label: 'Balance Sheet' },
  { id: 'ar-aging', label: 'A/R Aging' },
  { id: 'ap-aging', label: 'A/P Aging' },
];

export function Reports() {
  const [view, setView] = useState<ReportView>('trial-balance');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between border-b border-slate-200">
        <div className="flex gap-1">
          {SUB_TABS.map((tab) => {
            const isActive = view === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setView(tab.id)}
                className={
                  'border-b-2 px-3 py-2 text-sm transition-colors -mb-px ' +
                  (isActive
                    ? 'border-slate-900 font-medium text-slate-900'
                    : 'border-transparent text-slate-500 hover:text-slate-800')
                }
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {view === 'trial-balance' && <TrialBalance />}
      {view === 'pnl' && <ProfitAndLoss />}
      {view === 'balance-sheet' && <BalanceSheet />}
      {view === 'ar-aging' && <Aging mode="ar" />}
      {view === 'ap-aging' && <Aging mode="ap" />}
    </div>
  );
}
