import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface ActivityRow {
  id: string;
  occurredAt: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string;
  details: Record<string, unknown> | null;
  actorUserId: string | null;
  actorEmail: string | null;
}

interface ActivityResp {
  filter: Record<string, string | number | undefined>;
  rows: ActivityRow[];
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);
const firstOfMonth = (): string => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

const ACTION_TONE: Record<string, string> = {
  posted_entry: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  voided_payment: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  voided_bill: 'bg-rose-50 text-rose-700 ring-rose-600/20',
  voided_invoice: 'bg-rose-50 text-rose-700 ring-rose-600/20',
};

const DEFAULT_TONE = 'bg-slate-100 text-slate-700 ring-slate-300';

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function Activity() {
  const { companyId } = useCurrentCompany();
  const [from, setFrom] = useState<string>(firstOfMonth);
  const [to, setTo] = useState<string>(todayIso);
  const [action, setAction] = useState<string>('');
  const [entityType, setEntityType] = useState<string>('');

  const params = new URLSearchParams({ from, to });
  if (action.trim()) params.set('action', action.trim());
  if (entityType.trim()) params.set('entityType', entityType.trim());

  const query = useQuery({
    queryKey: ['activity', companyId, from, to, action, entityType],
    enabled: Boolean(companyId) && Boolean(from) && Boolean(to),
    queryFn: () =>
      api<ActivityResp>(`/activity?${params.toString()}`, { companyId }),
  });

  const rows = query.data?.rows ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Activity log</h2>
        <p className="text-sm text-slate-500">
          Append-only audit trail. Every posted journal entry (invoices, bills, payments,
          payroll, depreciation, disposals, manual entries) writes a row here. Newest first.
          Rows can never be edited or deleted — DB triggers enforce that.
        </p>
      </div>

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
        <Field label="Action">
          <input
            type="text"
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="e.g. posted_entry"
            className={inputClass + ' min-w-[180px]'}
          />
        </Field>
        <Field label="Entity type">
          <input
            type="text"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            placeholder="e.g. journal_entry"
            className={inputClass + ' min-w-[180px]'}
          />
        </Field>
      </div>

      {query.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : 'Failed to load.'}
        </p>
      )}

      {!query.isLoading && rows.length === 0 && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          No activity in this range.
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">When</th>
                <th className="px-4 py-2 text-left font-medium">Action</th>
                <th className="px-4 py-2 text-left font-medium">Entity</th>
                <th className="px-4 py-2 text-left font-medium">Summary</th>
                <th className="px-4 py-2 text-left font-medium">Actor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-2 font-mono text-xs text-slate-600">
                    {formatTimestamp(r.occurredAt)}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
                        (ACTION_TONE[r.action] ?? DEFAULT_TONE)
                      }
                    >
                      {r.action}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-600">
                    <div className="font-mono">{r.entityType}</div>
                    {r.entityId && (
                      <div className="font-mono text-[10px] text-slate-400">
                        {r.entityId.slice(0, 8)}…
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-900">{r.summary}</td>
                  <td className="px-4 py-2 text-xs text-slate-600">
                    {r.actorEmail ?? <span className="italic text-slate-400">system</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-slate-500">
        Showing up to 100 rows per query. Tighten the date range or add an action filter to
        narrow further.
      </p>
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
