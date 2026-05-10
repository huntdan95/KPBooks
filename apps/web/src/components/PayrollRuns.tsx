import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api, getApiBase, getIdToken } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type RunStatus = 'draft' | 'posted' | 'voided';
type WorkerType = 'contractor' | 'employee' | 'subcontractor';
type PaySchedule = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

interface PayrollRunListRow {
  id: string;
  payDate: string;
  periodStart: string;
  periodEnd: string;
  paySchedule: PaySchedule | null;
  workerTypeFilter: WorkerType | null;
  bankAccountId: string | null;
  status: RunStatus;
  totalGross: string;
  totalNet: string;
  memo: string | null;
}

interface PayrollRunLineRow {
  id: string;
  vendorId: string;
  vendorName: string | null;
  workerTypeAtCreation: WorkerType | null;
  hours: string | null;
  rate: string | null;
  gross: string;
  federalIncomeTax: string;
  socialSecurity: string;
  medicare: string;
  stateIncomeTax: string;
  otherDeductions: string;
  net: string;
  memo: string | null;
  postedPaymentId: string | null;
}

interface PayrollRunDetail extends PayrollRunListRow {
  lines: PayrollRunLineRow[];
}

interface EligibleWorker {
  vendorId: string;
  displayName: string;
  workerType: WorkerType | 'not_a_worker';
  payRate: string | null;
  payRateBasis: string | null;
  paySchedule: string | null;
  defaultExpenseAccountId: string | null;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  isActive: boolean;
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const addDaysIso = (base: string, days: number) => {
  const d = new Date(base + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function formatUsd(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === '') return '$0.00';
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const STATUS_TONE: Record<RunStatus, string> = {
  draft: 'bg-slate-100 text-slate-700 ring-slate-300',
  posted: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  voided: 'bg-rose-50 text-rose-700 ring-rose-600/20',
};

export function PayrollRuns() {
  const { companyId } = useCurrentCompany();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);

  const runsQ = useQuery({
    queryKey: ['payroll-runs', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ runs: PayrollRunListRow[] }>('/payroll-runs', { companyId }),
  });

  if (detailId) {
    return <PayrollRunDetailView runId={detailId} onBack={() => setDetailId(null)} />;
  }

  const runs = runsQ.data?.runs ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Pay runs</h2>
          <p className="text-sm text-slate-500">
            Batch entry for paychecks. Pick a period, fill in gross / withholdings / net per
            worker, then post once. Each line writes a real bill + payment via the same A/P pipeline
            you use elsewhere — KPBooks doesn't compute taxes; deductions are display-only on the
            pay-stub PDF.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowWizard((v) => !v)}
          className="whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          {showWizard ? 'Cancel' : '+ New pay run'}
        </button>
      </div>

      {showWizard && (
        <NewRunWizard
          onCreated={(id) => {
            setShowWizard(false);
            setDetailId(id);
          }}
        />
      )}

      {runsQ.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {runsQ.isError && (
        <p className="text-sm text-rose-600">
          {runsQ.error instanceof Error ? runsQ.error.message : 'Failed to load.'}
        </p>
      )}
      {!runsQ.isLoading && runs.length === 0 && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          No pay runs yet. Click "+ New pay run" above to start one.
        </p>
      )}

      {runs.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Pay date</th>
                <th className="px-4 py-2 text-left font-medium">Period</th>
                <th className="px-4 py-2 text-left font-medium">Filter</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Gross</th>
                <th className="px-4 py-2 text-right font-medium">Net</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {runs.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setDetailId(r.id)}
                  className="cursor-pointer hover:bg-slate-50"
                >
                  <td className="px-4 py-2 text-slate-900">{r.payDate}</td>
                  <td className="px-4 py-2 text-xs text-slate-600">
                    {r.periodStart} → {r.periodEnd}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-600">
                    {r.workerTypeFilter ?? 'All workers'}
                    {r.paySchedule && (
                      <span className="text-slate-400"> · {r.paySchedule}</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={
                        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
                        STATUS_TONE[r.status]
                      }
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">
                    {formatUsd(r.totalGross)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">
                    {formatUsd(r.totalNet)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- New run wizard --------------------------------------------------------

interface WizardDraft {
  payDate: string;
  periodStart: string;
  periodEnd: string;
  paySchedule: PaySchedule | '';
  workerTypeFilter: WorkerType | '';
  bankAccountId: string;
  memo: string;
}

const emptyWizardDraft = (): WizardDraft => {
  const today = todayIso();
  return {
    payDate: today,
    periodStart: addDaysIso(today, -14),
    periodEnd: addDaysIso(today, -1),
    paySchedule: 'biweekly',
    workerTypeFilter: 'employee',
    bankAccountId: '',
    memo: '',
  };
};

function NewRunWizard({ onCreated }: { onCreated: (id: string) => void }) {
  const { companyId } = useCurrentCompany();
  const [draft, setDraft] = useState<WizardDraft>(emptyWizardDraft);

  const accountsQ = useQuery({
    queryKey: ['accounts', companyId, 'payroll-runs-bank'],
    enabled: Boolean(companyId),
    queryFn: () => api<{ accounts: Account[] }>('/ledger/accounts?active=true', { companyId }),
  });
  const bankAccounts = (accountsQ.data?.accounts ?? []).filter(
    (a) => a.subtype === 'bank' || a.subtype === 'credit_card',
  );

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        payDate: draft.payDate,
        periodStart: draft.periodStart,
        periodEnd: draft.periodEnd,
      };
      if (draft.paySchedule) body.paySchedule = draft.paySchedule;
      if (draft.workerTypeFilter) body.workerTypeFilter = draft.workerTypeFilter;
      if (draft.bankAccountId) body.bankAccountId = draft.bankAccountId;
      if (draft.memo.trim()) body.memo = draft.memo.trim();
      return api<{ id: string }>('/payroll-runs', { method: 'POST', companyId, body });
    },
    onSuccess: (data) => onCreated(data.id),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mutation.isPending) return;
    mutation.mutate();
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 rounded-md border border-slate-200 bg-white p-4"
    >
      <h3 className="text-sm font-medium text-slate-700">New pay run</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Pay date" required>
          <input
            type="date"
            value={draft.payDate}
            onChange={(e) => setDraft({ ...draft, payDate: e.target.value })}
            required
            className={inputClass}
          />
        </Field>
        <Field label="Period start" required>
          <input
            type="date"
            value={draft.periodStart}
            onChange={(e) => setDraft({ ...draft, periodStart: e.target.value })}
            required
            className={inputClass}
          />
        </Field>
        <Field label="Period end" required>
          <input
            type="date"
            value={draft.periodEnd}
            onChange={(e) => setDraft({ ...draft, periodEnd: e.target.value })}
            required
            className={inputClass}
          />
        </Field>
        <Field label="Worker classification">
          <select
            value={draft.workerTypeFilter}
            onChange={(e) =>
              setDraft({ ...draft, workerTypeFilter: e.target.value as WorkerType | '' })
            }
            className={inputClass}
          >
            <option value="">All</option>
            <option value="employee">W-2 Employees</option>
            <option value="contractor">1099 Contractors</option>
            <option value="subcontractor">1099 Subcontractors</option>
          </select>
        </Field>
        <Field label="Pay schedule">
          <select
            value={draft.paySchedule}
            onChange={(e) =>
              setDraft({ ...draft, paySchedule: e.target.value as PaySchedule | '' })
            }
            className={inputClass}
          >
            <option value="">Any</option>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Biweekly</option>
            <option value="semimonthly">Semi-monthly</option>
            <option value="monthly">Monthly</option>
          </select>
        </Field>
        <Field label="Bank / cash account (for posting)">
          <select
            value={draft.bankAccountId}
            onChange={(e) => setDraft({ ...draft, bankAccountId: e.target.value })}
            className={inputClass}
          >
            <option value="">Pick later</option>
            {bankAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Memo">
        <input
          type="text"
          value={draft.memo}
          onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
          maxLength={500}
          placeholder="Bi-weekly payroll April 16–30"
          className={inputClass}
        />
      </Field>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {mutation.isPending ? 'Creating…' : 'Create draft'}
        </button>
        <p className="text-xs text-slate-500">
          You'll fill in line amounts on the next screen. Bank account can also be picked later.
        </p>
      </div>

      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error)}
        </div>
      )}
    </form>
  );
}

// --- Detail / line editor --------------------------------------------------

function PayrollRunDetailView({
  runId,
  onBack,
}: {
  runId: string;
  onBack: () => void;
}) {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();

  const detailQ = useQuery({
    queryKey: ['payroll-run', runId, companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<PayrollRunDetail>(`/payroll-runs/${runId}`, { companyId }),
  });

  const accountsQ = useQuery({
    queryKey: ['accounts', companyId, 'payroll-detail-bank'],
    enabled: Boolean(companyId),
    queryFn: () => api<{ accounts: Account[] }>('/ledger/accounts?active=true', { companyId }),
  });

  const data = detailQ.data;
  const isDraft = data?.status === 'draft';
  const isPosted = data?.status === 'posted';

  const eligibleQ = useQuery({
    queryKey: ['payroll-eligible', companyId, data?.workerTypeFilter, data?.paySchedule],
    enabled: Boolean(companyId) && Boolean(data) && isDraft,
    queryFn: () => {
      const params = new URLSearchParams();
      if (data?.workerTypeFilter) params.set('workerType', data.workerTypeFilter);
      if (data?.paySchedule) params.set('paySchedule', data.paySchedule);
      const qs = params.toString();
      return api<{ workers: EligibleWorker[] }>(
        `/payroll-runs/eligible-workers${qs ? `?${qs}` : ''}`,
        { companyId },
      );
    },
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['payroll-run', runId, companyId] });
    void queryClient.invalidateQueries({ queryKey: ['payroll-runs', companyId] });
  };

  const updateRunMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      api(`/payroll-runs/${runId}`, { method: 'PATCH', companyId, body }),
    onSuccess: invalidate,
  });

  const addLineMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      api(`/payroll-runs/${runId}/lines`, { method: 'POST', companyId, body }),
    onSuccess: invalidate,
  });

  const updateLineMutation = useMutation({
    mutationFn: async ({ lineId, body }: { lineId: string; body: Record<string, unknown> }) =>
      api(`/payroll-runs/${runId}/lines/${lineId}`, { method: 'PATCH', companyId, body }),
    onSuccess: invalidate,
  });

  const deleteLineMutation = useMutation({
    mutationFn: async (lineId: string) =>
      api(`/payroll-runs/${runId}/lines/${lineId}`, { method: 'DELETE', companyId }),
    onSuccess: invalidate,
  });

  const postMutation = useMutation({
    mutationFn: async () => api(`/payroll-runs/${runId}/post`, { method: 'POST', companyId }),
    onSuccess: invalidate,
  });

  const voidMutation = useMutation({
    mutationFn: async () => api(`/payroll-runs/${runId}/void`, { method: 'POST', companyId }),
    onSuccess: invalidate,
  });

  const deleteMutation = useMutation({
    mutationFn: async () => api(`/payroll-runs/${runId}`, { method: 'DELETE', companyId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['payroll-runs', companyId] });
      onBack();
    },
  });

  const eligibleWorkers = eligibleQ.data?.workers ?? [];
  const lineVendorIds = new Set((data?.lines ?? []).map((l) => l.vendorId));
  const availableToAdd = eligibleWorkers.filter((w) => !lineVendorIds.has(w.vendorId));
  const bankAccounts = (accountsQ.data?.accounts ?? []).filter(
    (a) => a.subtype === 'bank' || a.subtype === 'credit_card',
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          ← Back to pay runs
        </button>
        {data && isPosted && (
          <button
            type="button"
            onClick={() => {
              if (confirm('Void this run? Voids every linked payment + bill.')) {
                voidMutation.mutate();
              }
            }}
            className="rounded-md border border-rose-200 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50"
          >
            Void run
          </button>
        )}
        {data && isDraft && (data.lines.length === 0 || true) && (
          <button
            type="button"
            onClick={() => {
              if (confirm('Delete this draft run?')) deleteMutation.mutate();
            }}
            className="rounded-md border border-rose-200 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50"
          >
            Delete draft
          </button>
        )}
      </div>

      {detailQ.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {detailQ.isError && (
        <p className="text-sm text-rose-600">
          {detailQ.error instanceof Error ? detailQ.error.message : 'Failed to load.'}
        </p>
      )}

      {data && (
        <>
          <div className="rounded-md border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold tracking-tight text-slate-900">
                    Pay run · {data.payDate}
                  </h2>
                  <span
                    className={
                      'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ' +
                      STATUS_TONE[data.status]
                    }
                  >
                    {data.status}
                  </span>
                </div>
                <div className="text-xs text-slate-500">
                  Period {data.periodStart} → {data.periodEnd}
                  {data.workerTypeFilter && ` · ${data.workerTypeFilter}`}
                  {data.paySchedule && ` · ${data.paySchedule}`}
                </div>
                {data.memo && <div className="mt-1 text-sm italic text-slate-600">"{data.memo}"</div>}
              </div>
              <div className="grid grid-cols-2 gap-3 text-right">
                <div>
                  <div className="text-xs uppercase text-slate-500">Gross</div>
                  <div className="font-mono text-lg text-slate-700">
                    {formatUsd(data.totalGross)}
                  </div>
                </div>
                <div>
                  <div className="text-xs uppercase text-slate-500">Net</div>
                  <div className="font-mono text-lg font-semibold text-slate-900">
                    {formatUsd(data.totalNet)}
                  </div>
                </div>
              </div>
            </div>

            {isDraft && (
              <div className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-200 pt-4 sm:grid-cols-2">
                <Field label="Bank / cash account">
                  <select
                    value={data.bankAccountId ?? ''}
                    onChange={(e) =>
                      updateRunMutation.mutate({
                        bankAccountId: e.target.value || null,
                      })
                    }
                    className={inputClass}
                  >
                    <option value="">Required for posting</option>
                    {bankAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            )}
          </div>

          {data.lines.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">Worker</th>
                    <th className="px-3 py-2 text-right font-medium">Hrs</th>
                    <th className="px-3 py-2 text-right font-medium">Rate</th>
                    <th className="px-3 py-2 text-right font-medium">Gross</th>
                    <th className="px-3 py-2 text-right font-medium">FIT</th>
                    <th className="px-3 py-2 text-right font-medium">SS</th>
                    <th className="px-3 py-2 text-right font-medium">Med</th>
                    <th className="px-3 py-2 text-right font-medium">SIT</th>
                    <th className="px-3 py-2 text-right font-medium">Other</th>
                    <th className="px-3 py-2 text-right font-medium">Net</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {data.lines.map((l) => (
                    <LineRow
                      key={l.id}
                      line={l}
                      readOnly={!isDraft}
                      onUpdate={(body) => updateLineMutation.mutate({ lineId: l.id, body })}
                      onDelete={() => deleteLineMutation.mutate(l.id)}
                      runId={runId}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {isDraft && availableToAdd.length > 0 && (
            <AddLinePanel
              workers={availableToAdd}
              onAdd={(body) => addLineMutation.mutate(body)}
              busy={addLineMutation.isPending}
            />
          )}

          {isDraft && (
            <div className="flex items-center justify-end gap-3 border-t border-slate-200 pt-4">
              {data.lines.length === 0 && (
                <p className="mr-auto text-xs text-slate-500">
                  Add at least one line below before posting.
                </p>
              )}
              {data.lines.length > 0 && !data.bankAccountId && (
                <p className="mr-auto text-xs text-rose-600">
                  Pick a bank account above before posting.
                </p>
              )}
              <button
                type="button"
                onClick={() => {
                  if (
                    confirm(
                      `Post this run? ${data.lines.length} payments will be recorded. This locks every line.`,
                    )
                  ) {
                    postMutation.mutate();
                  }
                }}
                disabled={
                  postMutation.isPending ||
                  data.lines.length === 0 ||
                  !data.bankAccountId
                }
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {postMutation.isPending
                  ? 'Posting…'
                  : `Post run (${data.lines.length} line${data.lines.length === 1 ? '' : 's'})`}
              </button>
            </div>
          )}

          {(postMutation.isError || voidMutation.isError) && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formatError(postMutation.error ?? voidMutation.error)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LineRow({
  line,
  readOnly,
  onUpdate,
  onDelete,
  runId,
}: {
  line: PayrollRunLineRow;
  readOnly: boolean;
  onUpdate: (body: Record<string, unknown>) => void;
  onDelete: () => void;
  runId: string;
}) {
  const { companyId } = useCurrentCompany();
  const [draft, setDraft] = useState({
    hours: line.hours ?? '',
    rate: line.rate ?? '',
    gross: line.gross,
    fit: line.federalIncomeTax,
    ss: line.socialSecurity,
    med: line.medicare,
    sit: line.stateIncomeTax,
    other: line.otherDeductions,
  });

  const computedNet = (() => {
    const sum =
      Number(draft.fit || 0) +
      Number(draft.ss || 0) +
      Number(draft.med || 0) +
      Number(draft.sit || 0) +
      Number(draft.other || 0);
    return Number(draft.gross || 0) - sum;
  })();

  function onBlur(field: string, value: string) {
    const body: Record<string, unknown> = {};
    if (field === 'hours') body.hours = value || null;
    else if (field === 'rate') body.rate = value || null;
    else if (field === 'gross') body.gross = value || '0';
    else if (field === 'fit') body.federalIncomeTax = value || '0';
    else if (field === 'ss') body.socialSecurity = value || '0';
    else if (field === 'med') body.medicare = value || '0';
    else if (field === 'sit') body.stateIncomeTax = value || '0';
    else if (field === 'other') body.otherDeductions = value || '0';
    onUpdate(body);
  }

  async function downloadStub() {
    if (!line.postedPaymentId) return;
    try {
      const token = await getIdToken();
      const res = await fetch(`${getApiBase()}/payments/${line.postedPaymentId}/pay-stub.pdf`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(companyId ? { 'x-kpbooks-company': companyId } : {}),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(line.vendorName ?? 'worker').replace(/[^A-Za-z0-9]+/g, '_')}_PayStub.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Stub download failed.');
    }
  }
  void runId;

  if (readOnly) {
    return (
      <tr className={line.postedPaymentId ? '' : 'opacity-60'}>
        <td className="px-3 py-2 text-slate-900">{line.vendorName ?? '—'}</td>
        <td className="px-3 py-2 text-right font-mono text-xs text-slate-700">
          {line.hours ?? '—'}
        </td>
        <td className="px-3 py-2 text-right font-mono text-xs text-slate-700">
          {line.rate ? formatUsd(line.rate) : '—'}
        </td>
        <td className="px-3 py-2 text-right font-mono text-slate-900">{formatUsd(line.gross)}</td>
        <td className="px-3 py-2 text-right font-mono text-xs text-slate-600">
          {formatUsd(line.federalIncomeTax)}
        </td>
        <td className="px-3 py-2 text-right font-mono text-xs text-slate-600">
          {formatUsd(line.socialSecurity)}
        </td>
        <td className="px-3 py-2 text-right font-mono text-xs text-slate-600">
          {formatUsd(line.medicare)}
        </td>
        <td className="px-3 py-2 text-right font-mono text-xs text-slate-600">
          {formatUsd(line.stateIncomeTax)}
        </td>
        <td className="px-3 py-2 text-right font-mono text-xs text-slate-600">
          {formatUsd(line.otherDeductions)}
        </td>
        <td className="px-3 py-2 text-right font-mono font-semibold text-slate-900">
          {formatUsd(line.net)}
        </td>
        <td className="px-3 py-2 text-right">
          {line.postedPaymentId && (
            <button
              type="button"
              onClick={downloadStub}
              className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
            >
              Stub
            </button>
          )}
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td className="px-3 py-2 text-slate-900">{line.vendorName ?? '—'}</td>
      <td className="px-3 py-2">
        <NumInput
          value={draft.hours}
          onChange={(v) => setDraft({ ...draft, hours: v })}
          onBlur={() => onBlur('hours', draft.hours)}
          width="w-16"
        />
      </td>
      <td className="px-3 py-2">
        <NumInput
          value={draft.rate}
          onChange={(v) => setDraft({ ...draft, rate: v })}
          onBlur={() => onBlur('rate', draft.rate)}
          width="w-20"
        />
      </td>
      <td className="px-3 py-2">
        <NumInput
          value={draft.gross}
          onChange={(v) => setDraft({ ...draft, gross: v })}
          onBlur={() => onBlur('gross', draft.gross)}
          width="w-24"
        />
      </td>
      <td className="px-3 py-2">
        <NumInput
          value={draft.fit}
          onChange={(v) => setDraft({ ...draft, fit: v })}
          onBlur={() => onBlur('fit', draft.fit)}
          width="w-20"
        />
      </td>
      <td className="px-3 py-2">
        <NumInput
          value={draft.ss}
          onChange={(v) => setDraft({ ...draft, ss: v })}
          onBlur={() => onBlur('ss', draft.ss)}
          width="w-20"
        />
      </td>
      <td className="px-3 py-2">
        <NumInput
          value={draft.med}
          onChange={(v) => setDraft({ ...draft, med: v })}
          onBlur={() => onBlur('med', draft.med)}
          width="w-16"
        />
      </td>
      <td className="px-3 py-2">
        <NumInput
          value={draft.sit}
          onChange={(v) => setDraft({ ...draft, sit: v })}
          onBlur={() => onBlur('sit', draft.sit)}
          width="w-20"
        />
      </td>
      <td className="px-3 py-2">
        <NumInput
          value={draft.other}
          onChange={(v) => setDraft({ ...draft, other: v })}
          onBlur={() => onBlur('other', draft.other)}
          width="w-20"
        />
      </td>
      <td className="px-3 py-2 text-right font-mono font-semibold text-slate-900">
        {formatUsd(computedNet.toFixed(4))}
      </td>
      <td className="px-3 py-2 text-right">
        <button
          type="button"
          onClick={() => {
            if (confirm('Remove this line?')) onDelete();
          }}
          className="text-xs text-rose-600 hover:underline"
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

function NumInput({
  value,
  onChange,
  onBlur,
  width,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  width: string;
}) {
  return (
    <input
      type="text"
      inputMode="decimal"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      className={
        'rounded-md border border-slate-300 px-1.5 py-1 text-right font-mono text-xs focus:border-slate-900 focus:outline-none ' +
        width
      }
    />
  );
}

// --- Add-line panel --------------------------------------------------------

function AddLinePanel({
  workers,
  onAdd,
  busy,
}: {
  workers: EligibleWorker[];
  onAdd: (body: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [vendorId, setVendorId] = useState('');
  const [hours, setHours] = useState('');
  const [rate, setRate] = useState('');
  const [gross, setGross] = useState('');

  const picked = workers.find((w) => w.vendorId === vendorId);
  // Auto-fill rate from worker.payRate if user just picked them.
  if (picked && !rate && picked.payRate) {
    setRate(picked.payRate);
  }

  function submit() {
    if (!vendorId || !gross) return;
    const body: Record<string, unknown> = { vendorId, gross };
    if (hours) body.hours = hours;
    if (rate) body.rate = rate;
    onAdd(body);
    setVendorId('');
    setHours('');
    setRate('');
    setGross('');
  }

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-md border border-slate-200 bg-slate-50 p-3">
      <Field label="Add worker">
        <select
          value={vendorId}
          onChange={(e) => setVendorId(e.target.value)}
          className={inputClass + ' min-w-[200px]'}
        >
          <option value="">Pick…</option>
          {workers.map((w) => (
            <option key={w.vendorId} value={w.vendorId}>
              {w.displayName} ({w.workerType})
            </option>
          ))}
        </select>
      </Field>
      <Field label="Hours">
        <NumInput value={hours} onChange={setHours} onBlur={() => undefined} width="w-20" />
      </Field>
      <Field label="Rate">
        <NumInput value={rate} onChange={setRate} onBlur={() => undefined} width="w-24" />
      </Field>
      <Field label="Gross" required>
        <NumInput value={gross} onChange={setGross} onBlur={() => undefined} width="w-28" />
      </Field>
      <button
        type="button"
        onClick={submit}
        disabled={!vendorId || !gross || busy}
        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
      >
        + Add line
      </button>
      <p className="text-xs text-slate-500">
        Withholdings can be filled in on each row after adding. Net auto-computes.
      </p>
    </div>
  );
}

// --- Bits ------------------------------------------------------------------

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? 'Error'}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : 'Failed.';
}

const inputClass =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900';

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-0.5 text-rose-600">*</span>}
      </span>
      {children}
    </label>
  );
}
