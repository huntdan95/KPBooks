import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

interface Account {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  description: string | null;
  currency: string;
  isActive: boolean;
}

const TYPE_LABEL: Record<AccountType, string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expense',
};

const TYPE_COLOR: Record<AccountType, string> = {
  asset: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  liability: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  equity: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  revenue: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  expense: 'bg-rose-50 text-rose-700 ring-rose-600/20',
};

// Mirrors accountSubtypeEnum in packages/db/src/schema/enums.ts. Kept manually
// in sync rather than fetched from the API because the list is short and stable.
const SUBTYPES_BY_TYPE: Record<AccountType, string[]> = {
  asset: ['bank', 'accounts_receivable', 'other_current_asset', 'fixed_asset', 'other_asset'],
  liability: ['accounts_payable', 'credit_card', 'other_current_liability', 'long_term_liability'],
  equity: ['equity', 'retained_earnings'],
  revenue: ['income', 'other_income'],
  expense: ['expense', 'cost_of_goods_sold', 'other_expense'],
};

const TYPE_ORDER: AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

interface CreateDraft {
  code: string;
  name: string;
  type: AccountType;
  subtype: string;
  description?: string | undefined;
  currency: string;
}

interface EditDraft {
  code: string;
  name: string;
  description?: string | undefined;
  currency: string;
  isActive: boolean;
}

type FormMode =
  | null
  | { type: 'create'; draft: CreateDraft }
  | { type: 'edit'; id: string; original: Account; draft: EditDraft };

const emptyCreate: CreateDraft = {
  code: '',
  name: '',
  type: 'expense',
  subtype: 'expense',
  currency: 'USD',
};

export function AccountsList() {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<FormMode>(null);
  const [showInactive, setShowInactive] = useState(false);

  const query = useQuery({
    queryKey: ['accounts', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ accounts: Account[] }>('/ledger/accounts', { companyId }),
  });

  const createMutation = useMutation({
    mutationFn: async (draft: CreateDraft) => {
      const payload: Record<string, unknown> = {
        code: draft.code.trim(),
        name: draft.name.trim(),
        type: draft.type,
        subtype: draft.subtype,
        currency: draft.currency,
      };
      if (draft.description?.trim()) payload.description = draft.description.trim();
      return api<Account>('/ledger/accounts', { method: 'POST', companyId, body: payload });
    },
    onSuccess: () => {
      setMode(null);
      void queryClient.invalidateQueries({ queryKey: ['accounts', companyId] });
    },
  });

  const editMutation = useMutation({
    mutationFn: async ({ id, draft }: { id: string; draft: EditDraft }) => {
      const payload: Record<string, unknown> = {
        code: draft.code.trim(),
        name: draft.name.trim(),
        currency: draft.currency,
        isActive: draft.isActive,
        description: draft.description?.trim() || null,
      };
      return api<Account>(`/ledger/accounts/${id}`, { method: 'PATCH', companyId, body: payload });
    },
    onSuccess: () => {
      setMode(null);
      void queryClient.invalidateQueries({ queryKey: ['accounts', companyId] });
    },
  });

  function startCreate() {
    setMode({ type: 'create', draft: emptyCreate });
  }
  function startEdit(a: Account) {
    setMode({
      type: 'edit',
      id: a.id,
      original: a,
      draft: {
        code: a.code,
        name: a.name,
        currency: a.currency,
        description: a.description ?? undefined,
        isActive: a.isActive,
      },
    });
  }
  function cancel() {
    setMode(null);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!mode) return;
    if (mode.type === 'create') {
      if (!mode.draft.code.trim() || !mode.draft.name.trim()) return;
      if (createMutation.isPending) return;
      createMutation.mutate(mode.draft);
    } else {
      if (!mode.draft.code.trim() || !mode.draft.name.trim()) return;
      if (editMutation.isPending) return;
      editMutation.mutate({ id: mode.id, draft: mode.draft });
    }
  }

  if (query.isLoading) {
    return <p className="text-sm text-slate-500">Loading accounts…</p>;
  }
  if (query.isError) {
    return (
      <p className="text-sm text-rose-600">
        {query.error instanceof Error ? query.error.message : 'Failed to load accounts.'}
      </p>
    );
  }

  const all = query.data?.accounts ?? [];
  const visible = showInactive ? all : all.filter((a) => a.isActive);
  const sorted = [...visible].sort((a, b) => a.code.localeCompare(b.code));
  const byType = sorted.reduce<Partial<Record<AccountType, Account[]>>>((acc, a) => {
    (acc[a.type] ??= []).push(a);
    return acc;
  }, {});
  const inactiveCount = all.length - all.filter((a) => a.isActive).length;
  const mutating = createMutation.isPending || editMutation.isPending;
  const mutationErr = createMutation.error ?? editMutation.error;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Chart of Accounts</h2>
          <p className="text-sm text-slate-500">
            {all.length} accounts
            {inactiveCount > 0 && (
              <>
                {' '}
                ·{' '}
                <button
                  type="button"
                  onClick={() => setShowInactive((v) => !v)}
                  className="underline hover:text-slate-700"
                >
                  {showInactive ? 'hide' : 'show'} {inactiveCount} inactive
                </button>
              </>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={mode ? cancel : startCreate}
          className="whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          {mode ? 'Cancel' : '+ New account'}
        </button>
      </div>

      {mode && mode.type === 'create' && (
        <CreateAccountForm
          draft={mode.draft}
          onChange={(d) => setMode({ type: 'create', draft: d })}
          onSubmit={onSubmit}
          onCancel={cancel}
          isPending={createMutation.isPending}
          error={createMutation.error}
        />
      )}

      {mode && mode.type === 'edit' && (
        <EditAccountForm
          original={mode.original}
          draft={mode.draft}
          onChange={(d) => setMode({ type: 'edit', id: mode.id, original: mode.original, draft: d })}
          onSubmit={onSubmit}
          onCancel={cancel}
          isPending={editMutation.isPending}
          error={editMutation.error}
        />
      )}

      {!mode && mutating && <p className="text-sm text-slate-500">Saving…</p>}
      {!mode && mutationErr && (
        <p className="text-sm text-rose-600">{formatError(mutationErr)}</p>
      )}

      {TYPE_ORDER.map((type) => {
        const group = byType[type];
        if (!group?.length) return null;
        return (
          <section key={type} className="space-y-2">
            <h3 className="text-sm font-medium text-slate-700">{TYPE_LABEL[type]}</h3>
            <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
              {group.map((a) => (
                <li
                  key={a.id}
                  className={
                    'flex items-center justify-between gap-3 px-4 py-2.5 text-sm ' +
                    (a.isActive ? '' : 'opacity-60')
                  }
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-slate-500">{a.code}</span>
                    <span className="font-medium text-slate-900">{a.name}</span>
                    {!a.isActive && <span className="text-xs text-slate-500">(inactive)</span>}
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TYPE_COLOR[a.type]}`}
                    >
                      {a.subtype.replace(/_/g, ' ')}
                    </span>
                    <button
                      type="button"
                      onClick={() => startEdit(a)}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100"
                    >
                      Edit
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {sorted.length === 0 && (
        <p className="text-sm text-slate-500">
          {all.length === 0
            ? 'No accounts yet. Try creating a new company.'
            : 'No active accounts. Toggle "show inactive" above.'}
        </p>
      )}
    </div>
  );
}

function CreateAccountForm({
  draft,
  onChange,
  onSubmit,
  onCancel,
  isPending,
  error,
}: {
  draft: CreateDraft;
  onChange: (d: CreateDraft) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  isPending: boolean;
  error: unknown;
}) {
  const subtypes = SUBTYPES_BY_TYPE[draft.type];
  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-medium text-slate-700">New account</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Code" required>
          <input
            type="text"
            value={draft.code}
            onChange={(e) => onChange({ ...draft, code: e.target.value })}
            maxLength={40}
            required
            autoFocus
            placeholder="6500"
            className={inputClass + ' font-mono'}
          />
        </Field>
        <Field label="Name" required>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            maxLength={120}
            required
            placeholder="Meals & Entertainment"
            className={inputClass + ' sm:col-span-2'}
          />
        </Field>
        <Field label="Type" required>
          <select
            value={draft.type}
            onChange={(e) => {
              const t = e.target.value as AccountType;
              const next = SUBTYPES_BY_TYPE[t][0];
              onChange({ ...draft, type: t, subtype: next ?? draft.subtype });
            }}
            className={inputClass}
          >
            {TYPE_ORDER.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Subtype" required>
          <select
            value={draft.subtype}
            onChange={(e) => onChange({ ...draft, subtype: e.target.value })}
            className={inputClass}
          >
            {subtypes.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Currency">
          <input
            type="text"
            value={draft.currency}
            onChange={(e) => onChange({ ...draft, currency: e.target.value.toUpperCase() })}
            maxLength={8}
            className={inputClass + ' font-mono'}
          />
        </Field>
        <Field label="Description">
          <input
            type="text"
            value={draft.description ?? ''}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
            maxLength={500}
            className={inputClass + ' sm:col-span-3'}
          />
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!draft.code.trim() || !draft.name.trim() || isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? 'Saving…' : 'Save account'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>

      {error != null && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(error)}
        </div>
      )}
    </form>
  );
}

function EditAccountForm({
  original,
  draft,
  onChange,
  onSubmit,
  onCancel,
  isPending,
  error,
}: {
  original: Account;
  draft: EditDraft;
  onChange: (d: EditDraft) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  isPending: boolean;
  error: unknown;
}) {
  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">Edit account</h3>
        <span className="text-xs text-slate-500">
          Type/subtype locked: {TYPE_LABEL[original.type]} / {original.subtype.replace(/_/g, ' ')}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Code" required>
          <input
            type="text"
            value={draft.code}
            onChange={(e) => onChange({ ...draft, code: e.target.value })}
            maxLength={40}
            required
            autoFocus
            className={inputClass + ' font-mono'}
          />
        </Field>
        <Field label="Name" required>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            maxLength={120}
            required
            className={inputClass + ' sm:col-span-2'}
          />
        </Field>
        <Field label="Currency">
          <input
            type="text"
            value={draft.currency}
            onChange={(e) => onChange({ ...draft, currency: e.target.value.toUpperCase() })}
            maxLength={8}
            className={inputClass + ' font-mono'}
          />
        </Field>
        <Field label="Description">
          <input
            type="text"
            value={draft.description ?? ''}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
            maxLength={500}
            className={inputClass + ' sm:col-span-2'}
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={draft.isActive}
          onChange={(e) => onChange({ ...draft, isActive: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300"
        />
        Active
      </label>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!draft.code.trim() || !draft.name.trim() || isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>

      {error != null && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(error)}
        </div>
      )}
    </form>
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

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string; details?: unknown } | null;
    if (body?.message) return `${body.error ?? 'Error'}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : 'Failed to save.';
}
