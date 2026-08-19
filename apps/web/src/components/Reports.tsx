import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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

// Module-level constant, so it stores the translation key and t() runs at render.
const SUB_TABS: ReadonlyArray<{ id: ReportView; labelKey: string }> = [
  { id: 'trial-balance', labelKey: 'tabs.trialBalance' },
  { id: 'pnl', labelKey: 'tabs.pnl' },
  { id: 'balance-sheet', labelKey: 'tabs.balanceSheet' },
  { id: 'cash-flows', labelKey: 'tabs.cashFlows' },
  { id: 'cash-flow-forecast', labelKey: 'tabs.cashFlowForecast' },
  { id: 'ar-aging', labelKey: 'tabs.arAging' },
  { id: 'ap-aging', labelKey: 'tabs.apAging' },
  { id: 'payroll-register', labelKey: 'tabs.payrollRegister' },
  { id: 'workers-comp', labelKey: 'tabs.workersComp' },
  { id: 'sales-tax-liability', labelKey: 'tabs.salesTaxLiability' },
  { id: 'period-close', labelKey: 'tabs.periodClose' },
  { id: 'tax-rates', labelKey: 'tabs.taxRates' },
];

export function Reports() {
  const { t } = useTranslation('reports');
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
                {t(tab.labelKey)}
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
