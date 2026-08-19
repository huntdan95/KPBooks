import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type MatchType = 'contains' | 'starts_with' | 'ends_with' | 'exact' | 'regex';
type AmountSign = 'any' | 'positive' | 'negative';
type Translate = TFunction<readonly ['banking', 'common']>;

interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subtype: string;
  isActive: boolean;
}

interface BankRule {
  id: string;
  name: string;
  matchType: MatchType;
  matchValue: string;
  amountSign: AmountSign;
  targetAccountId: string;
  bankAccountId: string | null;
  memoTemplate: string | null;
  priority: number;
  isActive: boolean;
  hitCount: number;
  lastHitAt: string | null;
  createdAt: string;
}

interface RuleDraft {
  name: string;
  matchType: MatchType;
  matchValue: string;
  amountSign: AmountSign;
  targetAccountId: string;
  bankAccountId: string | '';
  memoTemplate: string;
  priority: number;
}

const MATCH_TYPES: readonly MatchType[] = [
  'contains',
  'starts_with',
  'ends_with',
  'exact',
  'regex',
];

const AMOUNT_SIGNS: readonly AmountSign[] = ['any', 'positive', 'negative'];

function emptyDraft(targetAccountId: string): RuleDraft {
  return {
    name: '',
    matchType: 'contains',
    matchValue: '',
    amountSign: 'any',
    targetAccountId,
    bankAccountId: '',
    memoTemplate: '',
    priority: 100,
  };
}

type FormMode = null | { type: 'create' } | { type: 'edit'; id: string };

export function BankRules() {
  const { t } = useTranslation(['banking', 'common']);
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<FormMode>(null);
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft(''));

  const accountsQ = useQuery({
    queryKey: ['accounts', companyId, 'rules-target'],
    enabled: Boolean(companyId),
    queryFn: () => api<{ accounts: Account[] }>('/ledger/accounts?active=true', { companyId }),
  });

  const rulesQ = useQuery({
    queryKey: ['bank-rules', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ rules: BankRule[] }>('/banking/rules', { companyId }),
  });

  const createMutation = useMutation({
    mutationFn: async (d: RuleDraft) =>
      api<BankRule>('/banking/rules', {
        method: 'POST',
        companyId,
        body: buildBody(d),
      }),
    onSuccess: () => {
      setMode(null);
      void queryClient.invalidateQueries({ queryKey: ['bank-rules', companyId] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, d }: { id: string; d: Partial<BankRule> & { matchValue?: string } }) =>
      api<BankRule>(`/banking/rules/${id}`, { method: 'PATCH', companyId, body: d }),
    onSuccess: () => {
      setMode(null);
      void queryClient.invalidateQueries({ queryKey: ['bank-rules', companyId] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api(`/banking/rules/${id}`, { method: 'DELETE', companyId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bank-rules', companyId] });
    },
  });

  const allAccounts = accountsQ.data?.accounts ?? [];
  // Bank-side rules pre-categorize the OTHER side of a bank line, so target must be a
  // revenue/expense/asset/liability account that's NOT A/R or A/P (server enforces too).
  const targetCandidates = allAccounts.filter(
    (a) =>
      a.subtype !== 'accounts_receivable' &&
      a.subtype !== 'accounts_payable' &&
      a.subtype !== 'bank',
  );
  const bankAccounts = allAccounts.filter(
    (a) => a.subtype === 'bank' || a.subtype === 'credit_card',
  );

  function startCreate() {
    setMode({ type: 'create' });
    setDraft(emptyDraft(targetCandidates[0]?.id ?? ''));
  }

  function startEdit(r: BankRule) {
    setMode({ type: 'edit', id: r.id });
    setDraft({
      name: r.name,
      matchType: r.matchType,
      matchValue: r.matchValue,
      amountSign: r.amountSign,
      targetAccountId: r.targetAccountId,
      bankAccountId: r.bankAccountId ?? '',
      memoTemplate: r.memoTemplate ?? '',
      priority: r.priority,
    });
  }

  function cancel() {
    setMode(null);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.name.trim() || !draft.matchValue.trim() || !draft.targetAccountId) return;
    if (mode?.type === 'create') createMutation.mutate(draft);
    else if (mode?.type === 'edit') updateMutation.mutate({ id: mode.id, d: buildBody(draft) });
  }

  const rules = rulesQ.data?.rules ?? [];
  const accountById = new Map(allAccounts.map((a) => [a.id, a]));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold tracking-tight text-slate-900">
            {t('rules.title')}
          </h3>
          <p className="text-sm text-slate-500">{t('rules.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={mode ? cancel : startCreate}
          disabled={targetCandidates.length === 0}
          className="whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mode ? t('common:cancel') : t('rules.newRule')}
        </button>
      </div>

      {mode && (
        <form
          onSubmit={onSubmit}
          className="space-y-3 rounded-md border border-slate-200 bg-white p-4"
        >
          <h4 className="text-sm font-medium text-slate-700">
            {mode.type === 'create' ? t('rules.formTitleCreate') : t('rules.formTitleEdit')}
          </h4>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t('common:name')} required>
              <input
                type="text"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={t('rules.placeholders.name')}
                maxLength={120}
                required
                autoFocus
                className={inputClass}
              />
            </Field>
            <Field label={t('rules.fields.priority')}>
              <input
                type="number"
                min={0}
                max={10000}
                value={draft.priority}
                onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
                className={inputClass}
              />
            </Field>
            <Field label={t('rules.fields.matchType')}>
              <select
                value={draft.matchType}
                onChange={(e) => setDraft({ ...draft, matchType: e.target.value as MatchType })}
                className={inputClass}
              >
                {MATCH_TYPES.map((mt) => (
                  <option key={mt} value={mt}>
                    {t(`matchType.${mt}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('rules.fields.matchValue')} required>
              <input
                type="text"
                value={draft.matchValue}
                onChange={(e) => setDraft({ ...draft, matchValue: e.target.value })}
                placeholder={
                  draft.matchType === 'regex'
                    ? '^uber\\s+(eats|trip)'
                    : t('rules.placeholders.matchValue')
                }
                maxLength={500}
                required
                className={inputClass}
              />
            </Field>
            <Field label={t('rules.fields.amountSign')}>
              <select
                value={draft.amountSign}
                onChange={(e) => setDraft({ ...draft, amountSign: e.target.value as AmountSign })}
                className={inputClass}
              >
                {AMOUNT_SIGNS.map((s) => (
                  <option key={s} value={s}>
                    {t(`amountSign.${s}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('rules.fields.bankAccountScope')}>
              <select
                value={draft.bankAccountId}
                onChange={(e) => setDraft({ ...draft, bankAccountId: e.target.value })}
                className={inputClass}
              >
                <option value="">{t('rules.allBankAccounts')}</option>
                {bankAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('rules.fields.categorizeAs')} required>
              <select
                value={draft.targetAccountId}
                onChange={(e) => setDraft({ ...draft, targetAccountId: e.target.value })}
                required
                className={inputClass}
              >
                {targetCandidates.length === 0 && (
                  <option value="">{t('rules.noEligibleAccounts')}</option>
                )}
                {targetCandidates.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.name} ({t(`accountType.${a.type}`, { defaultValue: a.type })})
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('rules.fields.memoOverride')}>
              <input
                type="text"
                value={draft.memoTemplate}
                onChange={(e) => setDraft({ ...draft, memoTemplate: e.target.value })}
                placeholder={t('rules.placeholders.memoOverride')}
                maxLength={500}
                className={inputClass}
              />
            </Field>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={
                !draft.name.trim() ||
                !draft.matchValue.trim() ||
                !draft.targetAccountId ||
                createMutation.isPending ||
                updateMutation.isPending
              }
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createMutation.isPending || updateMutation.isPending
                ? t('rules.saving')
                : t('rules.saveRule')}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
            >
              {t('common:cancel')}
            </button>
          </div>

          {(createMutation.isError || updateMutation.isError) && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
              {formatError(createMutation.error ?? updateMutation.error, t)}
            </div>
          )}
        </form>
      )}

      {rulesQ.isLoading && <p className="text-sm text-slate-500">{t('common:loading')}</p>}
      {rulesQ.isError && (
        <p className="text-sm text-rose-600">
          {rulesQ.error instanceof Error ? rulesQ.error.message : t('rules.loadFailed')}
        </p>
      )}
      {!rulesQ.isLoading && rules.length === 0 && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">
          {t('rules.empty')}
        </p>
      )}

      {rules.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">{t('rules.fields.priority')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('common:name')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('rules.columns.match')}</th>
                <th className="px-4 py-2 text-left font-medium">{t('rules.columns.sign')}</th>
                <th className="px-4 py-2 text-left font-medium">
                  {t('rules.columns.categorizeAs')}
                </th>
                <th className="px-4 py-2 text-right font-medium">{t('rules.columns.hits')}</th>
                <th className="px-4 py-2 text-center font-medium">{t('rules.columns.active')}</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {rules.map((r) => {
                const target = accountById.get(r.targetAccountId);
                return (
                  <tr key={r.id} className={r.isActive ? '' : 'opacity-50'}>
                    <td className="px-4 py-2 font-mono text-xs text-slate-500">{r.priority}</td>
                    <td className="px-4 py-2 text-slate-900">{r.name}</td>
                    <td className="px-4 py-2 text-slate-700">
                      <span className="text-xs text-slate-500">{t(`matchType.${r.matchType}`)}: </span>
                      <span className="font-mono text-xs">"{r.matchValue}"</span>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600">
                      {t(`amountSign.${r.amountSign}`)}
                    </td>
                    <td className="px-4 py-2 text-slate-700">
                      {target ? (
                        <>
                          <span className="font-mono text-xs text-slate-500">{target.code}</span>{' '}
                          {target.name}
                        </>
                      ) : (
                        <span className="text-rose-600">{t('rules.missingAccount')}</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-slate-700">
                      {r.hitCount}
                      {r.lastHitAt && (
                        <div className="text-[10px] text-slate-400">
                          {new Date(r.lastHitAt).toLocaleDateString()}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={r.isActive}
                        onChange={(e) =>
                          updateMutation.mutate({ id: r.id, d: { isActive: e.target.checked } })
                        }
                        className="h-4 w-4 rounded border-slate-300"
                      />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => startEdit(r)}
                          className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                        >
                          {t('common:edit')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (confirm(t('rules.deleteConfirm', { name: r.name })))
                              deleteMutation.mutate(r.id);
                          }}
                          className="rounded-md border border-rose-200 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                        >
                          {t('common:delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function buildBody(d: RuleDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: d.name.trim(),
    matchType: d.matchType,
    matchValue: d.matchValue.trim(),
    amountSign: d.amountSign,
    targetAccountId: d.targetAccountId,
    priority: d.priority,
  };
  if (d.bankAccountId) body.bankAccountId = d.bankAccountId;
  if (d.memoTemplate.trim()) body.memoTemplate = d.memoTemplate.trim();
  return body;
}

function formatError(err: unknown, t: Translate): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? t('errors.label')}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : t('errors.saveFailed');
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
