import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccountDetail, GeneralLedger, type AccountDrillTarget } from './AccountDetail';
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
  | 'general-ledger'
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
  { id: 'general-ledger', labelKey: 'tabs.generalLedger' },
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

/** A drill-down, plus the tab it was opened from so Back can name it. */
interface Drill extends AccountDrillTarget {
  origin: ReportView;
}

/**
 * The Back label per drill origin — a whole string each, not the tab name
 * interpolated into "← Back to {{report}}". Spanish needs the definite article,
 * which is gendered and contracts with `a`: "Volver AL libro mayor" but "Volver
 * A LA balanza de comprobación". One template cannot be right for both.
 */
const BACK_LABEL_KEY: Partial<Record<ReportView, string>> = {
  'trial-balance': 'accountDetail.backTo.trialBalance',
  pnl: 'accountDetail.backTo.pnl',
  'balance-sheet': 'accountDetail.backTo.balanceSheet',
  'general-ledger': 'accountDetail.backTo.generalLedger',
};

export function Reports() {
  const { t } = useTranslation('reports');
  const [view, setView] = useState<ReportView>('trial-balance');
  // The drill-down replaces the report body rather than pushing a route: it
  // belongs to the tab it was opened from, and picking any tab returns to it.
  const [drill, setDrill] = useState<Drill | null>(null);

  const openAccount = (origin: ReportView) => (target: AccountDrillTarget) =>
    setDrill({ ...target, origin });

  const backLabel = drill
    ? t(BACK_LABEL_KEY[drill.origin] ?? 'accountDetail.backTo.trialBalance')
    : '';

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
                onClick={() => {
                  setView(tab.id);
                  setDrill(null);
                }}
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

      {drill && (
        <AccountDetail
          // Re-key on the target so From/To and the page offset start fresh
          // for each new drill instead of carrying over from the last one.
          key={`${drill.accountId}:${drill.start}:${drill.end}`}
          target={drill}
          backLabel={backLabel}
          onBack={() => setDrill(null)}
        />
      )}

      {/* Hidden rather than unmounted while drilled in: coming back must land
          on the report exactly as it was left, date range and all. `hidden`
          also drops it out of the accessibility tree, so nothing is announced
          twice. */}
      <div hidden={Boolean(drill)}>
        <div className="space-y-4">
          {view === 'trial-balance' && (
            <TrialBalance onOpenAccount={openAccount('trial-balance')} />
          )}
          {view === 'pnl' && <ProfitAndLoss onOpenAccount={openAccount('pnl')} />}
          {view === 'balance-sheet' && (
            <BalanceSheet onOpenAccount={openAccount('balance-sheet')} />
          )}
          {view === 'general-ledger' && (
            <GeneralLedger onOpenAccount={openAccount('general-ledger')} />
          )}
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
      </div>
    </div>
  );
}
