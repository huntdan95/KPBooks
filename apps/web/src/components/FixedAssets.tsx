import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type AssetStatus = 'active' | 'disposed';
type DepreciationMethod = 'straight_line';

interface FixedAssetListRow {
  id: string;
  name: string;
  category: string | null;
  inServiceDate: string;
  cost: string;
  salvageValue: string;
  usefulLifeMonths: number;
  method: DepreciationMethod;
  status: AssetStatus;
  accumulatedDepreciation: string;
  netBookValue: string;
  lastDepreciatedThrough: string | null;
  disposalDate: string | null;
  monthsRemaining: number;
}

interface FixedAssetDetail extends FixedAssetListRow {
  description: string | null;
  assetAccountId: string;
  accumDeprAccountId: string;
  deprExpenseAccountId: string;
  disposalProceeds: string | null;
  disposalCashAccountId: string | null;
  disposalJournalEntryId: string | null;
  memo: string | null;
  monthlyDepreciation: string;
  history: Array<{
    journalEntryId: string;
    entryDate: string;
    reference: string | null;
    memo: string | null;
    amount: string;
  }>;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  isActive: boolean;
}

const todayIso = (): string => new Date().toISOString().slice(0, 10);
const lastDayOfThisMonth = (): string => {
  const d = new Date();
  // Day 0 of next month = last day of this month.
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return last.toISOString().slice(0, 10);
};

function formatUsd(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === '') return '$0.00';
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

const STATUS_TONE: Record<AssetStatus, string> = {
  active: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  disposed: 'bg-slate-100 text-slate-600 ring-slate-300',
};

export function FixedAssets() {
  const { companyId } = useCurrentCompany();
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [showRunDepr, setShowRunDepr] = useState(false);

  const assetsQ = useQuery({
    queryKey: ['fixed-assets', companyId],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ assets: FixedAssetListRow[] }>('/fixed-assets', { companyId }),
  });

  if (detailId) {
    return (
      <FixedAssetDetailView
        assetId={detailId}
        onBack={() => setDetailId(null)}
      />
    );
  }

  const assets = assetsQ.data?.assets ?? [];
  const active = assets.filter((a) => a.status === 'active');
  const disposed = assets.filter((a) => a.status === 'disposed');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            Fixed assets
          </h2>
          <p className="text-sm text-slate-500">
            Capitalized assets (vehicles, equipment, computers) with monthly straight-line
            depreciation. Each asset hooks to three GL accounts. "Run depreciation"
            posts one JE per asset-month through the date you pick.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowRunDepr((v) => !v)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            {showRunDepr ? 'Cancel' : 'Run depreciation…'}
          </button>
          <button
            type="button"
            onClick={() => setShowWizard((v) => !v)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            {showWizard ? 'Cancel' : '+ New asset'}
          </button>
        </div>
      </div>

      {showRunDepr && (
        <RunDepreciationPanel
          onDone={() => setShowRunDepr(false)}
        />
      )}

      {showWizard && (
        <NewAssetWizard
          onCreated={(id) => {
            setShowWizard(false);
            setDetailId(id);
          }}
        />
      )}

      {assetsQ.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {assetsQ.isError && (
        <p className="text-sm text-rose-600">
          {assetsQ.error instanceof Error ? assetsQ.error.message : 'Failed to load.'}
        </p>
      )}

      {!assetsQ.isLoading && assets.length === 0 && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          No fixed assets yet. Click "+ New asset" above to add one.
        </p>
      )}

      {active.length > 0 && (
        <AssetTable
          rows={active}
          title="Active"
          onPick={(id) => setDetailId(id)}
        />
      )}
      {disposed.length > 0 && (
        <AssetTable
          rows={disposed}
          title="Disposed"
          onPick={(id) => setDetailId(id)}
        />
      )}
    </div>
  );
}

function AssetTable({
  rows,
  title,
  onPick,
}: {
  rows: FixedAssetListRow[];
  title: string;
  onPick: (id: string) => void;
}) {
  const totalCost = rows.reduce((acc, r) => acc + Number(r.cost), 0);
  const totalAccum = rows.reduce((acc, r) => acc + Number(r.accumulatedDepreciation), 0);
  const totalNbv = rows.reduce((acc, r) => acc + Number(r.netBookValue), 0);

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium uppercase tracking-wider text-slate-500">
        {title} ({rows.length})
      </h3>
      <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Name</th>
              <th className="px-4 py-2 text-left font-medium">Category</th>
              <th className="px-4 py-2 text-left font-medium">In service</th>
              <th className="px-4 py-2 text-right font-medium">Cost</th>
              <th className="px-4 py-2 text-right font-medium">Accum. depr.</th>
              <th className="px-4 py-2 text-right font-medium">NBV</th>
              <th className="px-4 py-2 text-right font-medium">Mo. left</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => onPick(r.id)}
                className="cursor-pointer hover:bg-slate-50"
              >
                <td className="px-4 py-2 text-slate-900">{r.name}</td>
                <td className="px-4 py-2 text-xs text-slate-600">{r.category ?? '—'}</td>
                <td className="px-4 py-2 text-xs text-slate-600">{r.inServiceDate}</td>
                <td className="px-4 py-2 text-right font-mono text-slate-700">
                  {formatUsd(r.cost)}
                </td>
                <td className="px-4 py-2 text-right font-mono text-slate-700">
                  {formatUsd(r.accumulatedDepreciation)}
                </td>
                <td className="px-4 py-2 text-right font-mono text-slate-900">
                  {formatUsd(r.netBookValue)}
                </td>
                <td className="px-4 py-2 text-right font-mono text-xs text-slate-600">
                  {r.monthsRemaining}
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
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-100 text-sm font-semibold">
            <tr>
              <td colSpan={3} className="px-4 py-3 text-right text-slate-900">
                Totals
              </td>
              <td className="px-4 py-3 text-right font-mono text-slate-700">
                {formatUsd(totalCost)}
              </td>
              <td className="px-4 py-3 text-right font-mono text-slate-700">
                {formatUsd(totalAccum)}
              </td>
              <td className="px-4 py-3 text-right font-mono text-slate-900">
                {formatUsd(totalNbv)}
              </td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// --- New asset wizard ------------------------------------------------------

interface WizardDraft {
  name: string;
  category: string;
  description: string;
  inServiceDate: string;
  cost: string;
  salvageValue: string;
  usefulLifeMonths: string;
  assetAccountId: string;
  accumDeprAccountId: string;
  deprExpenseAccountId: string;
  memo: string;
}

const emptyDraft = (): WizardDraft => ({
  name: '',
  category: '',
  description: '',
  inServiceDate: todayIso(),
  cost: '',
  salvageValue: '0',
  usefulLifeMonths: '60',
  assetAccountId: '',
  accumDeprAccountId: '',
  deprExpenseAccountId: '',
  memo: '',
});

function NewAssetWizard({ onCreated }: { onCreated: (id: string) => void }) {
  const { companyId } = useCurrentCompany();
  const [draft, setDraft] = useState<WizardDraft>(emptyDraft);

  const accountsQ = useQuery({
    queryKey: ['accounts', companyId, 'fixed-assets'],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ accounts: Account[] }>('/ledger/accounts?active=true', { companyId }),
  });
  const accts = accountsQ.data?.accounts ?? [];
  const assetAccts = accts.filter(
    (a) => a.type === 'asset' && (a.subtype === 'fixed_asset' || a.subtype === 'other_asset'),
  );
  const expenseAccts = accts.filter((a) => a.type === 'expense');

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        inServiceDate: draft.inServiceDate,
        cost: draft.cost,
        salvageValue: draft.salvageValue || '0',
        usefulLifeMonths: Number(draft.usefulLifeMonths),
        assetAccountId: draft.assetAccountId,
        accumDeprAccountId: draft.accumDeprAccountId,
        deprExpenseAccountId: draft.deprExpenseAccountId,
      };
      if (draft.category.trim()) body.category = draft.category.trim();
      if (draft.description.trim()) body.description = draft.description.trim();
      if (draft.memo.trim()) body.memo = draft.memo.trim();
      return api<{ id: string }>('/fixed-assets', {
        method: 'POST',
        companyId,
        body,
      });
    },
    onSuccess: (data) => onCreated(data.id),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mutation.isPending) return;
    mutation.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-medium text-slate-700">New fixed asset</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Name" required>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            required
            maxLength={200}
            className={inputClass}
            placeholder="2024 Ford F-150"
          />
        </Field>
        <Field label="Category">
          <input
            type="text"
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            maxLength={100}
            className={inputClass}
            placeholder="Vehicle"
          />
        </Field>
        <Field label="In-service date" required>
          <input
            type="date"
            value={draft.inServiceDate}
            onChange={(e) => setDraft({ ...draft, inServiceDate: e.target.value })}
            required
            className={inputClass}
          />
        </Field>
        <Field label="Cost" required>
          <input
            type="text"
            inputMode="decimal"
            value={draft.cost}
            onChange={(e) => setDraft({ ...draft, cost: e.target.value })}
            required
            className={inputClass}
            placeholder="45000.00"
          />
        </Field>
        <Field label="Salvage value">
          <input
            type="text"
            inputMode="decimal"
            value={draft.salvageValue}
            onChange={(e) => setDraft({ ...draft, salvageValue: e.target.value })}
            className={inputClass}
            placeholder="0"
          />
        </Field>
        <Field label="Useful life (months)" required>
          <input
            type="number"
            min={1}
            max={600}
            value={draft.usefulLifeMonths}
            onChange={(e) => setDraft({ ...draft, usefulLifeMonths: e.target.value })}
            required
            className={inputClass}
          />
        </Field>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Asset account (DR at purchase)" required>
          <select
            value={draft.assetAccountId}
            onChange={(e) => setDraft({ ...draft, assetAccountId: e.target.value })}
            required
            className={inputClass}
          >
            <option value="">Pick…</option>
            {assetAccts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Accumulated depreciation (CR each month)" required>
          <select
            value={draft.accumDeprAccountId}
            onChange={(e) => setDraft({ ...draft, accumDeprAccountId: e.target.value })}
            required
            className={inputClass}
          >
            <option value="">Pick…</option>
            {assetAccts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Depreciation expense (DR each month)" required>
          <select
            value={draft.deprExpenseAccountId}
            onChange={(e) => setDraft({ ...draft, deprExpenseAccountId: e.target.value })}
            required
            className={inputClass}
          >
            <option value="">Pick…</option>
            {expenseAccts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Description">
        <textarea
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          maxLength={2000}
          rows={2}
          className={inputClass}
          placeholder="VIN, serial number, location, etc."
        />
      </Field>

      <Field label="Memo">
        <input
          type="text"
          value={draft.memo}
          onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
          maxLength={500}
          className={inputClass}
        />
      </Field>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {mutation.isPending ? 'Creating…' : 'Create asset'}
        </button>
        <p className="text-xs text-slate-500">
          The original purchase entry is separate — record it as a journal entry or bill against
          the same asset account.
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

// --- Run depreciation panel ------------------------------------------------

function RunDepreciationPanel({ onDone }: { onDone: () => void }) {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [throughDate, setThroughDate] = useState<string>(lastDayOfThisMonth());

  const mutation = useMutation({
    mutationFn: async () =>
      api<{
        results: Array<{
          assetId: string;
          monthsPosted: number;
          totalAmount: string;
          journalEntryIds: string[];
        }>;
        summary: {
          assetsProcessed: number;
          assetsWithPostings: number;
          totalMonthsPosted: number;
          totalEntriesPosted: number;
        };
      }>('/fixed-assets/run-depreciation', {
        method: 'POST',
        companyId,
        body: { throughDate },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fixed-assets', companyId] });
    },
  });

  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-medium text-slate-700">Run depreciation (all active assets)</h3>
      <p className="text-xs text-slate-500">
        Posts one JE per asset for every month from each asset's last-posted month through the
        last day of <code>{throughDate.slice(0, 7)}</code>. Skips assets already posted up
        to that month and assets at end of useful life. Idempotent.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Through date">
          <input
            type="date"
            value={throughDate}
            onChange={(e) => setThroughDate(e.target.value)}
            className={inputClass}
          />
        </Field>
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {mutation.isPending ? 'Posting…' : 'Run depreciation'}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          Close
        </button>
      </div>
      {mutation.isSuccess && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Posted {mutation.data.summary.totalEntriesPosted} JE(s) for{' '}
          {mutation.data.summary.assetsWithPostings} asset(s) ·{' '}
          {mutation.data.summary.totalMonthsPosted} month(s) total.
        </div>
      )}
      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error)}
        </div>
      )}
    </div>
  );
}

// --- Detail view -----------------------------------------------------------

function FixedAssetDetailView({
  assetId,
  onBack,
}: {
  assetId: string;
  onBack: () => void;
}) {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [showDispose, setShowDispose] = useState(false);

  const detailQ = useQuery({
    queryKey: ['fixed-asset', assetId, companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<FixedAssetDetail>(`/fixed-assets/${assetId}`, { companyId }),
  });

  const accountsQ = useQuery({
    queryKey: ['accounts', companyId, 'fixed-asset-detail'],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ accounts: Account[] }>('/ledger/accounts?active=true', { companyId }),
  });

  const data = detailQ.data;
  const accts = accountsQ.data?.accounts ?? [];
  const acctById = new Map(accts.map((a) => [a.id, a]));

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['fixed-asset', assetId, companyId] });
    void queryClient.invalidateQueries({ queryKey: ['fixed-assets', companyId] });
  };

  const runMut = useMutation({
    mutationFn: async (throughDate: string) =>
      api<{ monthsPosted: number; totalAmount: string; journalEntryIds: string[] }>(
        `/fixed-assets/${assetId}/run-depreciation`,
        { method: 'POST', companyId, body: { throughDate } },
      ),
    onSuccess: invalidate,
  });

  const deleteMut = useMutation({
    mutationFn: async () => api(`/fixed-assets/${assetId}`, { method: 'DELETE', companyId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fixed-assets', companyId] });
      onBack();
    },
  });

  const [throughDate, setThroughDate] = useState<string>(lastDayOfThisMonth());

  if (!data && detailQ.isLoading) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }
  if (detailQ.isError || !data) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          ← Back
        </button>
        <p className="text-sm text-rose-600">
          {detailQ.error instanceof Error ? detailQ.error.message : 'Failed to load.'}
        </p>
      </div>
    );
  }

  const isActive = data.status === 'active';
  const noHistory =
    Number(data.accumulatedDepreciation) === 0 && data.lastDepreciatedThrough === null;

  const acctLabel = (id: string | null): string => {
    if (!id) return '—';
    const a = acctById.get(id);
    return a ? `${a.code} — ${a.name}` : id.slice(0, 8);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          ← Back to fixed assets
        </button>
        <div className="flex gap-2">
          {isActive && (
            <button
              type="button"
              onClick={() => setShowDispose(true)}
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-900 hover:bg-amber-100"
            >
              Dispose…
            </button>
          )}
          {isActive && noHistory && (
            <button
              type="button"
              onClick={() => {
                if (confirm('Delete this asset? Only allowed before any depreciation has posted.')) {
                  deleteMut.mutate();
                }
              }}
              className="rounded-md border border-rose-200 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      <div className="rounded-md border border-slate-200 bg-white p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight text-slate-900">{data.name}</h2>
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
              {data.category && <>{data.category} · </>}
              In service {data.inServiceDate} · {data.usefulLifeMonths} months ·{' '}
              {data.method.replace('_', '-')}
            </div>
            {data.description && (
              <div className="mt-1 text-sm italic text-slate-600">{data.description}</div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 text-right">
            <div>
              <div className="text-xs uppercase text-slate-500">Cost</div>
              <div className="font-mono text-lg text-slate-700">{formatUsd(data.cost)}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-slate-500">NBV</div>
              <div className="font-mono text-lg font-semibold text-slate-900">
                {formatUsd(data.netBookValue)}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-200 pt-4 sm:grid-cols-4">
          <Stat label="Salvage" value={formatUsd(data.salvageValue)} />
          <Stat label="Monthly depr." value={formatUsd(data.monthlyDepreciation)} />
          <Stat label="Accum. depr." value={formatUsd(data.accumulatedDepreciation)} />
          <Stat
            label="Months left"
            value={`${data.monthsRemaining} / ${data.usefulLifeMonths}`}
          />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-200 pt-4 text-xs sm:grid-cols-3">
          <div>
            <div className="uppercase text-slate-500">Asset account</div>
            <div className="text-slate-700">{acctLabel(data.assetAccountId)}</div>
          </div>
          <div>
            <div className="uppercase text-slate-500">Accum. depr. account</div>
            <div className="text-slate-700">{acctLabel(data.accumDeprAccountId)}</div>
          </div>
          <div>
            <div className="uppercase text-slate-500">Depr. expense account</div>
            <div className="text-slate-700">{acctLabel(data.deprExpenseAccountId)}</div>
          </div>
        </div>

        {data.status === 'disposed' && (
          <div className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-200 pt-4 text-xs sm:grid-cols-3">
            <div>
              <div className="uppercase text-slate-500">Disposed on</div>
              <div className="text-slate-700">{data.disposalDate ?? '—'}</div>
            </div>
            <div>
              <div className="uppercase text-slate-500">Proceeds</div>
              <div className="font-mono text-slate-700">{formatUsd(data.disposalProceeds)}</div>
            </div>
            <div>
              <div className="uppercase text-slate-500">Cash account</div>
              <div className="text-slate-700">{acctLabel(data.disposalCashAccountId)}</div>
            </div>
          </div>
        )}
      </div>

      {isActive && (
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-medium text-slate-700">Run depreciation</h3>
          <p className="mt-1 text-xs text-slate-500">
            Posts a JE for every missing month from{' '}
            {data.lastDepreciatedThrough
              ? `after ${data.lastDepreciatedThrough}`
              : `${data.inServiceDate}'s month-end`}{' '}
            through the last day of the chosen month. Idempotent — re-running with the same
            date does nothing.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field label="Through date">
              <input
                type="date"
                value={throughDate}
                onChange={(e) => setThroughDate(e.target.value)}
                className={inputClass}
              />
            </Field>
            <button
              type="button"
              onClick={() => runMut.mutate(throughDate)}
              disabled={runMut.isPending}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {runMut.isPending ? 'Posting…' : 'Run'}
            </button>
            {runMut.isSuccess && (
              <span className="text-xs text-emerald-700">
                Posted {runMut.data.monthsPosted} month(s) · {formatUsd(runMut.data.totalAmount)}
              </span>
            )}
          </div>
          {runMut.isError && (
            <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formatError(runMut.error)}
            </div>
          )}
        </div>
      )}

      {showDispose && (
        <DisposePanel
          asset={data}
          accounts={accts}
          onDone={() => {
            setShowDispose(false);
            invalidate();
          }}
          onCancel={() => setShowDispose(false)}
        />
      )}

      {data.history.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <h3 className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700">
            Posted journal entries ({data.history.length})
          </h3>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Date</th>
                <th className="px-4 py-2 text-left font-medium">Reference</th>
                <th className="px-4 py-2 text-left font-medium">Memo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {data.history.map((h) => (
                <tr key={h.journalEntryId}>
                  <td className="px-4 py-2 text-xs text-slate-700">{h.entryDate}</td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-700">{h.reference ?? '—'}</td>
                  <td className="px-4 py-2 text-xs text-slate-600">{h.memo ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- Dispose panel ---------------------------------------------------------

function DisposePanel({
  asset,
  accounts,
  onDone,
  onCancel,
}: {
  asset: FixedAssetDetail;
  accounts: Account[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { companyId } = useCurrentCompany();
  const [disposalDate, setDisposalDate] = useState<string>(todayIso());
  const [proceeds, setProceeds] = useState<string>('0');
  const [cashAccountId, setCashAccountId] = useState<string>('');
  const [gainLossAccountId, setGainLossAccountId] = useState<string>('');
  const [memo, setMemo] = useState<string>('');

  const cashAccts = accounts.filter(
    (a) => a.subtype === 'bank' || a.subtype === 'credit_card',
  );
  // Gain on disposal = revenue / other_income; Loss on disposal = expense / other_expense.
  const gainLossAccts = accounts.filter(
    (a) =>
      a.subtype === 'other_income' ||
      a.subtype === 'income' ||
      a.subtype === 'other_expense' ||
      a.subtype === 'expense',
  );

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        disposalDate,
        proceeds,
      };
      if (Number(proceeds) > 0 && cashAccountId) body.cashAccountId = cashAccountId;
      if (gainLossAccountId) body.gainLossAccountId = gainLossAccountId;
      if (memo.trim()) body.memo = memo.trim();
      return api<{
        assetId: string;
        journalEntryId: string;
        netBookValue: string;
        gainLoss: string;
      }>(`/fixed-assets/${asset.id}/dispose`, { method: 'POST', companyId, body });
    },
    onSuccess: () => onDone(),
  });

  // Predict gain/loss for the user before they hit submit.
  // NBV at disposal = current NBV (we'll re-run depreciation through the disposal
  // date server-side first, but the predicted figure here is close enough for UI).
  const proceedsN = Number(proceeds || '0');
  const nbvN = Number(asset.netBookValue);
  const gainLossN = proceedsN - nbvN;

  return (
    <div className="space-y-3 rounded-md border border-amber-200 bg-amber-50/30 p-4">
      <h3 className="text-sm font-medium text-slate-900">Dispose asset</h3>
      <p className="text-xs text-slate-600">
        First catches up depreciation through the disposal date, then posts ONE final JE: zeros
        accumulated depreciation, removes the asset cost, records cash received (if any), and
        plugs gain/loss to the account you pick. The asset becomes read-only after.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Disposal date" required>
          <input
            type="date"
            value={disposalDate}
            onChange={(e) => setDisposalDate(e.target.value)}
            min={asset.inServiceDate}
            required
            className={inputClass}
          />
        </Field>
        <Field label="Proceeds (0 for junk/donate)" required>
          <input
            type="text"
            inputMode="decimal"
            value={proceeds}
            onChange={(e) => setProceeds(e.target.value)}
            required
            className={inputClass}
          />
        </Field>
        <Field label="Cash / bank account">
          <select
            value={cashAccountId}
            onChange={(e) => setCashAccountId(e.target.value)}
            disabled={proceedsN <= 0}
            className={inputClass}
          >
            <option value="">{proceedsN > 0 ? 'Pick…' : 'N/A — no proceeds'}</option>
            {cashAccts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Gain / loss account">
          <select
            value={gainLossAccountId}
            onChange={(e) => setGainLossAccountId(e.target.value)}
            disabled={gainLossN === 0}
            className={inputClass}
          >
            <option value="">{gainLossN === 0 ? 'N/A — no gain/loss' : 'Pick…'}</option>
            {gainLossAccts.map((a) => (
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
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          maxLength={500}
          className={inputClass}
          placeholder="Sold to ABC Salvage"
        />
      </Field>
      <div className="grid grid-cols-3 gap-3 rounded-md bg-white p-3 text-sm">
        <div>
          <div className="text-xs uppercase text-slate-500">Predicted NBV</div>
          <div className="font-mono text-slate-700">{formatUsd(asset.netBookValue)}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">Proceeds</div>
          <div className="font-mono text-slate-700">{formatUsd(proceedsN)}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">
            {gainLossN >= 0 ? 'Predicted gain' : 'Predicted loss'}
          </div>
          <div
            className={
              'font-mono text-base font-semibold ' +
              (gainLossN > 0
                ? 'text-emerald-700'
                : gainLossN < 0
                  ? 'text-rose-700'
                  : 'text-slate-700')
            }
          >
            {formatUsd(Math.abs(gainLossN))}
          </div>
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Predicted figures use today's accumulated depreciation. The server will catch up through
        the disposal month first, so the final numbers may shift if you haven't run depreciation
        recently.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            if (confirm(`Dispose "${asset.name}"? This is irreversible (creates a final JE).`)) {
              mutation.mutate();
            }
          }}
          disabled={mutation.isPending || !disposalDate}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {mutation.isPending ? 'Disposing…' : 'Confirm disposal'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error)}
        </div>
      )}
    </div>
  );
}

// --- Bits ------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-0.5 font-mono text-base text-slate-900">{value}</div>
    </div>
  );
}

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
