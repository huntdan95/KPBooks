import { useState } from 'react';
import { Aging } from './Aging';
import { BalanceSheet } from './BalanceSheet';
import { CashFlowForecast } from './CashFlowForecast';
import { PayrollRegister } from './PayrollRegister';
import { PeriodClose } from './PeriodClose';
import { ProfitAndLoss } from './ProfitAndLoss';
import { SalesTaxLiability } from './SalesTaxLiability';
import { StatementOfCashFlows } from './StatementOfCashFlows';
import { TaxRates } from './TaxRates';
import { TrialBalance } from './TrialBalance';
import { WorkersCompSummary } from './WorkersCompSummary';

type ReportView =
  | 'trial-balance'
  | 'pnl'
  | 'balance-sheet'
  | 'cash-flows'
  | 'cash-flow-forecast'
  | 'ar-aging'
  | 'ap-aging'
  | 'payroll-register'
  | 'workers-comp'
  | 'sales-tax-liability'
  | 'period-close'
  | 'tax-rates';

const SUB_TABS: ReadonlyArray<{ id: ReportView; label: string }> = [
  { id: 'trial-balance', label: 'Trial Balance' },
  { id: 'pnl', label: 'Profit & Loss' },
  { id: 'balance-sheet', label: 'Balance Sheet' },
  { id: 'cash-flows', label: 'Cash Flows' },
  { id: 'cash-flow-forecast', label: 'Cash Flow Forecast' },
  { id: 'ar-aging', label: 'A/R Aging' },
  { id: 'ap-aging', label: 'A/P Aging' },
  { id: 'payroll-register', label: 'Payroll Register' },
  { id: 'workers-comp', label: "Workers' Comp" },
  { id: 'sales-tax-liability', label: 'Sales Tax Liability' },
  { id: 'period-close', label: 'Close Period' },
  { id: 'tax-rates', label: 'Tax Rates' },
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
      {view === 'cash-flows' && <StatementOfCashFlows />}
      {view === 'cash-flow-forecast' && <CashFlowForecast />}
      {view === 'ar-aging' && <Aging mode="ar" />}
      {view === 'ap-aging' && <Aging mode="ap" />}
      {view === 'payroll-register' && <PayrollRegister />}
      {view === 'workers-comp' && <WorkersCompSummary />}
      {view === 'sales-tax-liability' && <SalesTaxLiability />}
      {view === 'period-close' && <PeriodClose />}
      {view === 'tax-rates' && <TaxRates />}
    </div>
  );
}
