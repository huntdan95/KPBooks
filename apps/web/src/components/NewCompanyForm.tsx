import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface CreateCompanyResponse {
  id: string;
  name: string;
  accountsCreated: number;
}

/**
 * The shared "create a new company" form. Used both by the splash screen
 * (CreateCompany.tsx) when the user has no memberships AND by the modal
 * triggered from the company picker once they're inside the app.
 *
 * On success: switches the active company to the newly-created one and
 * invalidates the /me query so the picker shows the new entry.
 */
export function NewCompanyForm({
  onCreated,
  autoFocus = true,
}: {
  /** Called with the new company id after successful creation. */
  onCreated?: (id: string) => void;
  autoFocus?: boolean;
}) {
  const [name, setName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [ein, setEin] = useState('');
  const queryClient = useQueryClient();
  const { setCompanyId } = useCurrentCompany();

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = { name: name.trim() };
      if (legalName.trim()) body.legalName = legalName.trim();
      if (ein.trim()) body.ein = ein.trim();
      return api<CreateCompanyResponse>('/companies', { method: 'POST', body });
    },
    onSuccess: (data) => {
      setCompanyId(data.id);
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      onCreated?.(data.id);
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || mutation.isPending) return;
    mutation.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">Display name *</span>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Bookkeeping LLC"
          autoFocus={autoFocus}
          required
          maxLength={120}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">Legal name (optional)</span>
        <input
          type="text"
          value={legalName}
          onChange={(e) => setLegalName(e.target.value)}
          placeholder="Acme Bookkeeping, LLC"
          maxLength={160}
          className={inputClass}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">EIN (optional)</span>
        <input
          type="text"
          value={ein}
          onChange={(e) => setEin(e.target.value)}
          placeholder="12-3456789"
          maxLength={20}
          className={inputClass + ' font-mono'}
        />
      </label>

      <div className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
        We'll seed a default chart of accounts (26 accounts covering the common asset / liability /
        equity / revenue / expense categories) you can edit anytime from the Chart of Accounts tab.
      </div>

      <button
        type="submit"
        disabled={mutation.isPending || !name.trim()}
        className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {mutation.isPending ? 'Creating…' : 'Create client'}
      </button>

      {mutation.isError && (
        <p className="text-sm text-rose-600">
          {mutation.error instanceof ApiError
            ? (() => {
                const body = mutation.error.body as { error?: string; message?: string } | null;
                return body?.message ?? body?.error ?? 'Failed to create client.';
              })()
            : mutation.error instanceof Error
              ? mutation.error.message
              : 'Failed to create client.'}
        </p>
      )}
    </form>
  );
}

const inputClass =
  'w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900';
