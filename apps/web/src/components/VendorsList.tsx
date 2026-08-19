import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { VendorDetail } from './CounterpartyDetail';
import { MergeDuplicatesModal } from './MergeDuplicatesModal';
import { EmptyState } from './ui/EmptyState';

interface Vendor {
  id: string;
  displayName: string;
  companyName: string | null;
  accountNumber: string | null;
  email: string | null;
  phone: string | null;
  defaultTermsDays: number | null;
  is1099Vendor: boolean;
  taxId: string | null;
  isActive: boolean;
  openingBalance: string;
  notes?: string | null;
}

interface FormDraft {
  displayName: string;
  companyName?: string | undefined;
  accountNumber?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  defaultTermsDays?: number | undefined;
  is1099Vendor: boolean;
  taxId?: string | undefined;
  notes?: string | undefined;
  isActive: boolean;
}

type FormMode = null | { type: 'create' } | { type: 'edit'; id: string };

const emptyDraft: FormDraft = { displayName: '', is1099Vendor: false, isActive: true };

function rowToDraft(v: Vendor): FormDraft {
  return {
    displayName: v.displayName,
    companyName: v.companyName ?? undefined,
    accountNumber: v.accountNumber ?? undefined,
    email: v.email ?? undefined,
    phone: v.phone ?? undefined,
    defaultTermsDays: v.defaultTermsDays ?? undefined,
    is1099Vendor: v.is1099Vendor,
    taxId: v.taxId ?? undefined,
    notes: v.notes ?? undefined,
    isActive: v.isActive,
  };
}

function buildPayload(draft: FormDraft, mode: 'create' | 'edit'): Record<string, unknown> {
  const out: Record<string, unknown> = {
    displayName: draft.displayName.trim(),
    is1099Vendor: draft.is1099Vendor,
  };
  out.companyName = draft.companyName?.trim() || null;
  out.accountNumber = draft.accountNumber?.trim() || null;
  out.email = draft.email?.trim() || null;
  out.phone = draft.phone?.trim() || null;
  out.taxId = draft.taxId?.trim() || null;
  out.notes = draft.notes?.trim() || null;
  out.defaultTermsDays =
    draft.defaultTermsDays === undefined ? null : draft.defaultTermsDays;
  if (mode === 'edit') out.isActive = draft.isActive;

  if (mode === 'create') {
    for (const k of Object.keys(out)) {
      if (out[k] === null) delete out[k];
    }
  }
  return out;
}

export function VendorsList() {
  const { t } = useTranslation(['purchases', 'common']);
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<FormMode>(null);
  const [draft, setDraft] = useState<FormDraft>(emptyDraft);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showMerge, setShowMerge] = useState<boolean>(false);

  // NOTE: every hook MUST run on every render; do NOT add an early
  // `if (detailId) return ...` between hooks here. The branch lives below
  // after every hook has been called.
  const query = useQuery({
    queryKey: ['vendors', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ vendors: Vendor[] }>('/vendors', { companyId }),
  });

  const mutation = useMutation({
    mutationFn: async () => {
      if (mode === null) throw new Error('no mode');
      const payload = buildPayload(draft, mode.type);
      if (mode.type === 'create') {
        return api<Vendor>('/vendors', { method: 'POST', companyId, body: payload });
      }
      return api<Vendor>(`/vendors/${mode.id}`, { method: 'PATCH', companyId, body: payload });
    },
    onSuccess: () => {
      setMode(null);
      setDraft(emptyDraft);
      void queryClient.invalidateQueries({ queryKey: ['vendors', companyId] });
    },
  });

  function startCreate() {
    setMode({ type: 'create' });
    setDraft(emptyDraft);
  }
  function startEdit(v: Vendor) {
    setMode({ type: 'edit', id: v.id });
    setDraft(rowToDraft(v));
  }
  function cancel() {
    setMode(null);
    setDraft(emptyDraft);
  }

  const taxIdMissing = draft.is1099Vendor && !(draft.taxId ?? '').trim();
  const canSubmit = !!draft.displayName.trim() && !taxIdMissing;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || mutation.isPending) return;
    mutation.mutate();
  }

  const vendors = query.data?.vendors ?? [];

  // Branch AFTER all hooks have been called; see note at top of component.
  if (detailId) {
    return <VendorDetail vendorId={detailId} onBack={() => setDetailId(null)} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            {t('vendors.title')}
          </h2>
          <p className="text-sm text-slate-500">{t('onFile', { count: vendors.length })}</p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowMerge(true)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            {t('vendors.mergeDuplicates')}
          </button>
          <button
            type="button"
            onClick={mode ? cancel : startCreate}
            className="whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            {mode ? t('common:cancel') : t('vendors.newVendorCta')}
          </button>
        </div>
      </div>

      {showMerge && (
        <MergeDuplicatesModal kind="vendor" onClose={() => setShowMerge(false)} />
      )}

      {mode && (
        <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-medium text-slate-700">
            {mode.type === 'create' ? t('vendors.createTitle') : t('vendors.editTitle')}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('vendors.fields.displayName')} required>
              <input
                type="text"
                value={draft.displayName}
                onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                maxLength={200}
                required
                autoFocus
                className={inputClass}
              />
            </Field>
            <Field label={t('vendors.fields.companyName')}>
              <input
                type="text"
                value={draft.companyName ?? ''}
                onChange={(e) => setDraft({ ...draft, companyName: e.target.value })}
                maxLength={200}
                className={inputClass}
              />
            </Field>
            <Field label={t('vendors.fields.accountNumber')}>
              <input
                type="text"
                value={draft.accountNumber ?? ''}
                onChange={(e) => setDraft({ ...draft, accountNumber: e.target.value })}
                maxLength={40}
                placeholder="V-203"
                className={inputClass}
              />
            </Field>
            <Field label={t('vendors.fields.email')}>
              <input
                type="email"
                value={draft.email ?? ''}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                maxLength={200}
                className={inputClass}
              />
            </Field>
            <Field label={t('vendors.fields.phone')}>
              <input
                type="tel"
                value={draft.phone ?? ''}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                maxLength={40}
                className={inputClass}
              />
            </Field>
            <Field label={t('vendors.fields.defaultTerms')}>
              <input
                type="number"
                min={0}
                max={365}
                value={draft.defaultTermsDays ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    defaultTermsDays: e.target.value === '' ? undefined : Number(e.target.value),
                  })
                }
                placeholder="30"
                className={inputClass}
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={draft.is1099Vendor}
              onChange={(e) => setDraft({ ...draft, is1099Vendor: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300"
            />
            {t('vendors.fields.is1099')}
          </label>

          {draft.is1099Vendor && (
            <Field label={t('vendors.fields.taxId')} required>
              <input
                type="text"
                value={draft.taxId ?? ''}
                onChange={(e) => setDraft({ ...draft, taxId: e.target.value })}
                maxLength={40}
                placeholder={t('vendors.fields.taxIdPlaceholder')}
                required
                className={inputClass}
              />
            </Field>
          )}

          {mode.type === 'edit' && (
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={draft.isActive}
                onChange={(e) => setDraft({ ...draft, isActive: e.target.checked })}
                className="h-4 w-4 rounded border-slate-300"
              />
              {t('vendors.fields.active')}
            </label>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!canSubmit || mutation.isPending}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation.isPending
                ? t('vendors.saving')
                : mode.type === 'create'
                  ? t('vendors.saveVendor')
                  : t('vendors.saveChanges')}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
            >
              {t('common:cancel')}
            </button>
            {taxIdMissing && (
              <span className="text-xs text-slate-500">{t('vendors.taxIdRequired')}</span>
            )}
          </div>

          {mutation.isError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formatError(mutation.error, {
                error: t('errors.label'),
                fallback: t('errors.saveFailed'),
              })}
            </div>
          )}
        </form>
      )}

      {query.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {query.isError && (
        <p className="text-sm text-rose-600">
          {query.error instanceof Error ? query.error.message : t('vendors.loadFailed')}
        </p>
      )}
      {!query.isLoading && vendors.length === 0 && (
        <EmptyState
          icon="building-2"
          title={t('vendors.empty.title')}
          description={t('vendors.empty.description')}
          action={{ label: t('vendors.empty.action'), onClick: startCreate }}
        />
      )}

      {vendors.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">{t('vendors.table.accountNumber')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('vendors.table.displayName')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('vendors.table.email')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('vendors.table.phone')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('vendors.table.terms')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('vendors.table.form1099')}</th>
                <th className="px-4 py-2 text-right font-medium">
                  {t('vendors.table.openingBalance')}
                </th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {vendors.map((v) => (
                <tr
                  key={v.id}
                  onClick={() => setDetailId(v.id)}
                  className={
                    'cursor-pointer hover:bg-slate-50 ' + (v.isActive ? '' : 'opacity-60')
                  }
                >
                  <td className="px-4 py-2 font-mono text-slate-500">{v.accountNumber ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-900">
                    <div className="font-medium">
                      {v.displayName}
                      {!v.isActive && (
                        <span className="ml-2 text-xs text-slate-500">
                          {t('vendors.inactiveSuffix')}
                        </span>
                      )}
                    </div>
                    {v.companyName && <div className="text-xs text-slate-500">{v.companyName}</div>}
                  </td>
                  <td className="px-4 py-2 text-slate-700">{v.email ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-700">{v.phone ?? '—'}</td>
                  <td className="px-4 py-2 text-right text-slate-700">
                    {v.defaultTermsDays === null
                      ? '—'
                      : t('vendors.netTerms', { days: v.defaultTermsDays })}
                  </td>
                  <td className="px-4 py-2 text-center text-slate-700">{v.is1099Vendor ? '✓' : '—'}</td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">
                    {Number(v.openingBalance) === 0 ? '—' : v.openingBalance}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit(v);
                      }}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                    >
                      {t('common:edit')}
                    </button>
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

function formatError(err: unknown, labels: { error: string; fallback: string }): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string; details?: unknown } | null;
    if (body?.message) return `${body.error ?? labels.error}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : labels.fallback;
}
