/**
 * Mileage tracking — placeholder. Schema + UI for trip logging, IRS standard
 * mileage rate computation, and posting to vehicle / mileage expense
 * accounts ships in a follow-up slice.
 */
export function Mileage() {
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Mileage</h2>
        <p className="text-sm text-slate-500">
          Log business trips, compute IRS-standard mileage deductions, and post to a vehicle
          expense account at month-end.
        </p>
      </div>
      <div className="rounded-md border-2 border-dashed border-slate-300 bg-white p-8 text-center">
        <p className="text-sm font-medium text-slate-700">Coming soon</p>
        <p className="mt-1 text-xs text-slate-500">
          v1 will include: trip log (date / start / end / odometer / purpose), per-trip auto-
          calculated deduction at the current IRS rate (configurable), and a one-click "Post
          mileage to GL" workflow that creates a journal entry crediting an Owner Reimbursement
          account.
        </p>
      </div>
    </div>
  );
}
