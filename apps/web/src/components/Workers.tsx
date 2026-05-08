/**
 * Workers / Employees — placeholder. Full payroll module (employees,
 * paychecks via printed-check workflow, federal/state/FICA withholding,
 * 941/940/W-2 filings) ships in Phase 2 per the roadmap. Per the office
 * profile, no ACH direct deposit is needed.
 */
export function Workers() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Workers</h2>
        <p className="text-sm text-slate-500">
          Employees, paychecks, and payroll-tax filings. Direct deposit is intentionally not
          included — clients use printed checks (per office workflow).
        </p>
      </div>
      <div className="rounded-md border-2 border-dashed border-slate-300 bg-white p-8 text-center">
        <p className="text-sm font-medium text-slate-700">Coming in Phase 2</p>
        <p className="mt-1 text-xs text-slate-500 max-w-2xl mx-auto">
          What ships next: employee records (W-4 + state withholding), gross→net paycheck calc
          (FIT / SIT / FICA / Medicare / SUTA), MICR-encoded check printing for paychecks,
          paystub PDF, payroll-tax-liability accrual, and 941/940/W-2 form generation.
        </p>
      </div>
    </div>
  );
}
