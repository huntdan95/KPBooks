import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface WorkersCompSummaryRow {
  workersCompClass: string | null;
  workerCount: number;
  totalPaid: string;
}

interface WorkersCompSummaryResp {
  from: string;
  to: string;
  rows: WorkersCompSummaryRow[];
  totalPaid: string;
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const firstOfYear = () => `${new Date().getUTCFullYear()}-01-01`;

function formatUsd(s: string | number): string {
  if (s === null || s === undefined || s === '') return '$0.00';
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function WorkersCompSummary() {
  const { companyId } = useCurrentCompany();
  const [from, setFrom] = useState<string>(firstOfYear);
  const [to, setTo] = useState<string>(todayIso);

  const query = useQuery({
    queryKey: ['workers-comp-summary', companyId, from, to],
    enabled: Boolean(companyId) && Boolean(from) && Boolean(to),
    queryFn: () =>
      api<WorkersCompSummaryResp>(
        `/ledger/reports/workers-comp-summary?from=${from}&to=${to}`,
        { companyId },
      ),
  });

  const data = query.data;
  const unclassifiedRow = data?.rows.find((r) => r.workersCompClass === null);
  const classifiedTotal = data
    ? data.rows
        .filter((r) => r.workersCompClass !== null)
        .reduce((acc, r) => acc + Number(r.totalPaid), 0)
    : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From">
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="To">
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      <p className="text-xs text-slate-500">
        Workers' comp summary: payments to active workers grouped by{' '}
        <code>workers_comp_class</code>. Use this at WC-audit / WC-recertification time to hand
        the carrier a per-class breakdown of labor dollars. Workers without a class fall into the
        "unclassified" row at the bottom — assign codes on the Workers page.
      </p>

      {query.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : 'Failed to load.'}
        </p>
      )}

      {data && (
        <>
          {unclassifiedRow && unclassifiedRow.workerCount > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <strong>{unclassifiedRow.workerCount}</strong> active worker(s) totaling{' '}
              <strong>{formatUsd(unclassifiedRow.totalPaid)}</strong> in this period have no
              workers' comp class assigned. Carriers will usually default these to the highest-
              risk rate; assign a class on each worker's record to fix.
            </div>
          )}

          {data.rows.length === 0 ? (
            <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
              No payments to active workers in this period.
            </p>
          ) : (
            <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2 text-left font-medium">WC class</th>
                    <th className="px-4 py-2 text-right font-medium">Worker count</th>
                    <th className="px-4 py-2 text-right font-medium">Total paid</th>
                    <th className="px-4 py-2 text-right font-medium">% of total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {data.rows.map((r) => {
                    const pct =
                      Number(data.totalPaid) > 0
                        ? (Number(r.totalPaid) / Number(data.totalPaid)) * 100
                        : 0;
                    const unclassified = r.workersCompClass === null;
                    return (
                      <tr key={r.workersCompClass ?? '__unclassified__'}>
                        <td className="px-4 py-2">
                          {unclassified ? (
                            <span className="rounded-md bg-rose-50 px-2 py-0.5 text-xs text-rose-700 ring-1 ring-rose-200">
                              unclassified
                            </span>
                          ) : (
                            <span className="font-mono text-slate-700">
                              {r.workersCompClass}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-slate-700">
                          {r.workerCount}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-slate-900">
                          {formatUsd(r.totalPaid)}
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-xs text-slate-500">
                          {pct.toFixed(1)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot className="bg-slate-100 text-sm font-semibold">
                  <tr>
                    <td className="px-4 py-3 text-right text-slate-900">
                      Total ({data.from} → {data.to})
                    </td>
                    <td className="px-4 py-3 text-right text-slate-700"></td>
                    <td className="px-4 py-3 text-right font-mono text-slate-900">
                      {formatUsd(data.totalPaid)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-slate-500">
                      {Number(data.totalPaid) > 0
                        ? ((classifiedTotal / Number(data.totalPaid)) * 100).toFixed(1)
                        : '0.0'}
                      % classified
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const inputClass =
  'rounded-md border border-slate-300 bg-white px-2 py-1 text-sm focus:border-slate-900 focus:outline-none';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm text-slate-600">
      <span>{label}</span>
      {children}
    </label>
  );
}
