import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation(['payroll', 'common']);
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
            {t('fixedAssets.title')}
          </h2>
          <p className="text-sm text-slate-500">
            {t('fixedAssets.blurb', { action: t('fixedAssets.runDepr') })}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowRunDepr((v) => !v)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            {showRunDepr ? t('common:cancel') : t('fixedAssets.runDeprAction')}
          </button>
          <button
            type="button"
            onClick={() => setShowWizard((v) => !v)}
            className="whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            {showWizard ? t('common:cancel') : t('fixedAssets.newAssetAction')}
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

      {assetsQ.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {assetsQ.isError && (
        <p className="text-sm text-rose-600">
          {assetsQ.error instanceof Error ? assetsQ.error.message : t('failedToLoad')}
        </p>
      )}

      {!assetsQ.isLoading && assets.length === 0 && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          {t('fixedAssets.empty', { action: t('fixedAssets.newAssetAction') })}
        </p>
      )}

      {active.length > 0 && (
        <AssetTable
          rows={active}
          title={t('fixedAssets.sections.active')}
          onPick={(id) => setDetailId(id)}
        />
      )}
      {disposed.length > 0 && (
        <AssetTable
          rows={disposed}
          title={t('fixedAssets.sections.disposed')}
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
  const { t } = useTranslation(['payroll', 'common']);
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
              <th className="px-4 py-2 text-left font-medium">{t('common:name')}</th>
              <th className="px-4 py-2 text-left font-medium">
                {t('fixedAssets.columns.category')}
              </th>
              <th className="px-4 py-2 text-left font-medium">
                {t('fixedAssets.columns.inService')}
              </th>
              <th className="px-4 py-2 text-right font-medium">
                {t('fixedAssets.columns.cost')}
              </th>
              <th className="px-4 py-2 text-right font-medium">
                {t('fixedAssets.columns.accumDepr')}
              </th>
              <th className="px-4 py-2 text-right font-medium">
                {t('fixedAssets.columns.nbv')}
              </th>
              <th className="px-4 py-2 text-right font-medium">
                {t('fixedAssets.columns.monthsLeft')}
              </th>
              <th className="px-4 py-2 text-left font-medium">{t('common:status')}</th>
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
                    {t(`fixedAssets.status.${r.status}`)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-100 text-sm font-semibold">
            <tr>
              <td colSpan={3} className="px-4 py-3 text-right text-slate-900">
                {t('fixedAssets.totals')}
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
  const { t } = useTranslation(['payroll', 'common']);
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
      <h3 className="text-sm font-medium text-slate-700">{t('fixedAssets.newAsset')}</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t('common:name')} required>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            required
            maxLength={200}
            className={inputClass}
            placeholder={t('fixedAssets.placeholders.name')}
          />
        </Field>
        <Field label={t('fixedAssets.fields.category')}>
          <input
            type="text"
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            maxLength={100}
            className={inputClass}
            placeholder={t('fixedAssets.placeholders.category')}
          />
        </Field>
        <Field label={t('fixedAssets.fields.inServiceDate')} required>
          <input
            type="date"
            value={draft.inServiceDate}
            onChange={(e) => setDraft({ ...draft, inServiceDate: e.target.value })}
            required
            className={inputClass}
          />
        </Field>
        <Field label={t('fixedAssets.fields.cost')} required>
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
        <Field label={t('fixedAssets.fields.salvageValue')}>
          <input
            type="text"
            inputMode="decimal"
            value={draft.salvageValue}
            onChange={(e) => setDraft({ ...draft, salvageValue: e.target.value })}
            className={inputClass}
            placeholder="0"
          />
        </Field>
        <Field label={t('fixedAssets.fields.usefulLife')} required>
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
        <Field label={t('fixedAssets.fields.assetAccount')} required>
          <select
            value={draft.assetAccountId}
            onChange={(e) => setDraft({ ...draft, assetAccountId: e.target.value })}
            required
            className={inputClass}
          >
            <option value="">{t('fixedAssets.pick')}</option>
            {assetAccts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('fixedAssets.fields.accumDeprAccount')} required>
          <select
            value={draft.accumDeprAccountId}
            onChange={(e) => setDraft({ ...draft, accumDeprAccountId: e.target.value })}
            required
            className={inputClass}
          >
            <option value="">{t('fixedAssets.pick')}</option>
            {assetAccts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('fixedAssets.fields.deprExpenseAccount')} required>
          <select
            value={draft.deprExpenseAccountId}
            onChange={(e) => setDraft({ ...draft, deprExpenseAccountId: e.target.value })}
            required
            className={inputClass}
          >
            <option value="">{t('fixedAssets.pick')}</option>
            {expenseAccts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label={t('fixedAssets.fields.description')}>
        <textarea
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          maxLength={2000}
          rows={2}
          className={inputClass}
          placeholder={t('fixedAssets.placeholders.description')}
        />
      </Field>

      <Field label={t('common:memo')}>
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
          {mutation.isPending ? t('fixedAssets.creating') : t('fixedAssets.createAsset')}
        </button>
        <p className="text-xs text-slate-500">{t('fixedAssets.purchaseEntryHint')}</p>
      </div>

      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error, { error: t('shell:errors.label'), fallback: t('failed') })}
        </div>
      )}
    </form>
  );
}

// --- Run depreciation panel ------------------------------------------------

function RunDepreciationPanel({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation(['payroll', 'common']);
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
      <h3 className="text-sm font-medium text-slate-700">{t('fixedAssets.runDeprAll')}</h3>
      <p className="text-xs text-slate-500">
        {t('fixedAssets.runDeprAllBlurbBefore')} <code>{throughDate.slice(0, 7)}</code>
        {t('fixedAssets.runDeprAllBlurbAfter')}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('fixedAssets.fields.throughDate')}>
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
          {mutation.isPending ? t('fixedAssets.posting') : t('fixedAssets.runDepr')}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          {t('common:close')}
        </button>
      </div>
      {mutation.isSuccess && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {t('fixedAssets.runDeprAllResult', {
            entries: mutation.data.summary.totalEntriesPosted,
            assets: mutation.data.summary.assetsWithPostings,
            months: mutation.data.summary.totalMonthsPosted,
          })}
        </div>
      )}
      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error, { error: t('shell:errors.label'), fallback: t('failed') })}
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
  const { t } = useTranslation(['payroll', 'common']);
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
    return <p className="text-sm text-slate-500">{t('common:loading')}</p>;
  }
  if (detailQ.isError || !data) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          {t('fixedAssets.back')}
        </button>
        <p className="text-sm text-rose-600">
          {detailQ.error instanceof Error ? detailQ.error.message : t('failedToLoad')}
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
          {t('fixedAssets.backToList')}
        </button>
        <div className="flex gap-2">
          {isActive && (
            <button
              type="button"
              onClick={() => setShowDispose(true)}
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm text-amber-900 hover:bg-amber-100"
            >
              {t('fixedAssets.disposeAction')}
            </button>
          )}
          {isActive && noHistory && (
            <button
              type="button"
              onClick={() => {
                if (confirm(t('fixedAssets.confirmDelete'))) {
                  deleteMut.mutate();
                }
              }}
              className="rounded-md border border-rose-200 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50"
            >
              {t('common:delete')}
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
                {t(`fixedAssets.status.${data.status}`)}
              </span>
            </div>
            <div className="text-xs text-slate-500">
              {data.category && <>{data.category} · </>}
              {t('fixedAssets.detailMeta', {
                date: data.inServiceDate,
                months: data.usefulLifeMonths,
              })}{' '}
              · {t(`fixedAssets.method.${data.method}`)}
            </div>
            {data.description && (
              <div className="mt-1 text-sm italic text-slate-600">{data.description}</div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 text-right">
            <div>
              <div className="text-xs uppercase text-slate-500">
                {t('fixedAssets.columns.cost')}
              </div>
              <div className="font-mono text-lg text-slate-700">{formatUsd(data.cost)}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-slate-500">
                {t('fixedAssets.columns.nbv')}
              </div>
              <div className="font-mono text-lg font-semibold text-slate-900">
                {formatUsd(data.netBookValue)}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-200 pt-4 sm:grid-cols-4">
          <Stat label={t('fixedAssets.stats.salvage')} value={formatUsd(data.salvageValue)} />
          <Stat
            label={t('fixedAssets.stats.monthlyDepr')}
            value={formatUsd(data.monthlyDepreciation)}
          />
          <Stat
            label={t('fixedAssets.columns.accumDepr')}
            value={formatUsd(data.accumulatedDepreciation)}
          />
          <Stat
            label={t('fixedAssets.stats.monthsLeft')}
            value={`${data.monthsRemaining} / ${data.usefulLifeMonths}`}
          />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-200 pt-4 text-xs sm:grid-cols-3">
          <div>
            <div className="uppercase text-slate-500">{t('fixedAssets.stats.assetAccount')}</div>
            <div className="text-slate-700">{acctLabel(data.assetAccountId)}</div>
          </div>
          <div>
            <div className="uppercase text-slate-500">
              {t('fixedAssets.stats.accumDeprAccount')}
            </div>
            <div className="text-slate-700">{acctLabel(data.accumDeprAccountId)}</div>
          </div>
          <div>
            <div className="uppercase text-slate-500">
              {t('fixedAssets.stats.deprExpenseAccount')}
            </div>
            <div className="text-slate-700">{acctLabel(data.deprExpenseAccountId)}</div>
          </div>
        </div>

        {data.status === 'disposed' && (
          <div className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-200 pt-4 text-xs sm:grid-cols-3">
            <div>
              <div className="uppercase text-slate-500">{t('fixedAssets.stats.disposedOn')}</div>
              <div className="text-slate-700">{data.disposalDate ?? '—'}</div>
            </div>
            <div>
              <div className="uppercase text-slate-500">{t('fixedAssets.stats.proceeds')}</div>
              <div className="font-mono text-slate-700">{formatUsd(data.disposalProceeds)}</div>
            </div>
            <div>
              <div className="uppercase text-slate-500">{t('fixedAssets.stats.cashAccount')}</div>
              <div className="text-slate-700">{acctLabel(data.disposalCashAccountId)}</div>
            </div>
          </div>
        )}
      </div>

      {isActive && (
        <div className="rounded-md border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-medium text-slate-700">{t('fixedAssets.runDepr')}</h3>
          <p className="mt-1 text-xs text-slate-500">
            {t('fixedAssets.runDeprBlurbBefore')}{' '}
            {data.lastDepreciatedThrough
              ? t('fixedAssets.afterDate', { date: data.lastDepreciatedThrough })
              : t('fixedAssets.monthEndOf', { date: data.inServiceDate })}{' '}
            {t('fixedAssets.runDeprBlurbAfter')}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Field label={t('fixedAssets.fields.throughDate')}>
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
              {runMut.isPending ? t('fixedAssets.posting') : t('fixedAssets.run')}
            </button>
            {runMut.isSuccess && (
              <span className="text-xs text-emerald-700">
                {t('fixedAssets.runResult', {
                  count: runMut.data.monthsPosted,
                  amount: formatUsd(runMut.data.totalAmount),
                })}
              </span>
            )}
          </div>
          {runMut.isError && (
            <div className="mt-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formatError(runMut.error, { error: t('shell:errors.label'), fallback: t('failed') })}
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
            {t('fixedAssets.postedJEs', { count: data.history.length })}
          </h3>
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">{t('common:date')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('common:reference')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('common:memo')}</th>
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
  const { t } = useTranslation(['payroll', 'common']);
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
      <h3 className="text-sm font-medium text-slate-900">{t('fixedAssets.disposeTitle')}</h3>
      <p className="text-xs text-slate-600">{t('fixedAssets.disposeBlurb')}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label={t('fixedAssets.fields.disposalDate')} required>
          <input
            type="date"
            value={disposalDate}
            onChange={(e) => setDisposalDate(e.target.value)}
            min={asset.inServiceDate}
            required
            className={inputClass}
          />
        </Field>
        <Field label={t('fixedAssets.fields.proceeds')} required>
          <input
            type="text"
            inputMode="decimal"
            value={proceeds}
            onChange={(e) => setProceeds(e.target.value)}
            required
            className={inputClass}
          />
        </Field>
        <Field label={t('fixedAssets.fields.cashAccount')}>
          <select
            value={cashAccountId}
            onChange={(e) => setCashAccountId(e.target.value)}
            disabled={proceedsN <= 0}
            className={inputClass}
          >
            <option value="">
              {proceedsN > 0 ? t('fixedAssets.pick') : t('fixedAssets.naNoProceeds')}
            </option>
            {cashAccts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('fixedAssets.fields.gainLossAccount')}>
          <select
            value={gainLossAccountId}
            onChange={(e) => setGainLossAccountId(e.target.value)}
            disabled={gainLossN === 0}
            className={inputClass}
          >
            <option value="">
              {gainLossN === 0 ? t('fixedAssets.naNoGainLoss') : t('fixedAssets.pick')}
            </option>
            {gainLossAccts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={t('common:memo')}>
        <input
          type="text"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          maxLength={500}
          className={inputClass}
          placeholder={t('fixedAssets.placeholders.disposeMemo')}
        />
      </Field>
      <div className="grid grid-cols-3 gap-3 rounded-md bg-white p-3 text-sm">
        <div>
          <div className="text-xs uppercase text-slate-500">
            {t('fixedAssets.stats.predictedNbv')}
          </div>
          <div className="font-mono text-slate-700">{formatUsd(asset.netBookValue)}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">
            {t('fixedAssets.stats.proceeds')}
          </div>
          <div className="font-mono text-slate-700">{formatUsd(proceedsN)}</div>
        </div>
        <div>
          <div className="text-xs uppercase text-slate-500">
            {gainLossN >= 0
              ? t('fixedAssets.stats.predictedGain')
              : t('fixedAssets.stats.predictedLoss')}
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
      <p className="text-xs text-slate-500">{t('fixedAssets.predictedHint')}</p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            if (confirm(t('fixedAssets.confirmDispose', { name: asset.name }))) {
              mutation.mutate();
            }
          }}
          disabled={mutation.isPending || !disposalDate}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {mutation.isPending ? t('fixedAssets.disposing') : t('fixedAssets.confirmDisposal')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          {t('common:cancel')}
        </button>
      </div>
      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error, { error: t('shell:errors.label'), fallback: t('failed') })}
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

function formatError(err: unknown, labels: { error: string; fallback: string }): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? labels.error}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : labels.fallback;
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
