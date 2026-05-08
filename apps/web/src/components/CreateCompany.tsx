import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { signOut } from '../lib/firebase';

interface CreateCompanyResponse {
  id: string;
  name: string;
  accountsCreated: number;
}

export function CreateCompany() {
  const [name, setName] = useState('');
  const queryClient = useQueryClient();
  const { setCompanyId } = useCurrentCompany();

  const mutation = useMutation({
    mutationFn: async (input: { name: string }) =>
      api<CreateCompanyResponse>('/companies', { method: 'POST', body: input }),
    onSuccess: (data) => {
      setCompanyId(data.id);
      void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    mutation.mutate({ name: name.trim() });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <form
        onSubmit={onSubmit}
        className="w-full max-w-md space-y-5 rounded-lg border border-slate-200 bg-white p-8 shadow-sm"
      >
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-slate-900">
            Create your first company
          </h1>
          <p className="text-sm text-slate-600">
            We'll seed a default chart of accounts you can edit later.
          </p>
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-700">Company name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Bookkeeping LLC"
            autoFocus
            required
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          />
        </label>
        <button
          type="submit"
          disabled={mutation.isPending || !name.trim()}
          className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {mutation.isPending ? 'Creating...' : 'Create company'}
        </button>
        {mutation.isError && (
          <p className="text-sm text-red-600">
            {mutation.error instanceof Error ? mutation.error.message : 'Failed to create company.'}
          </p>
        )}
        <button
          type="button"
          onClick={() => void signOut()}
          className="w-full text-xs text-slate-500 hover:text-slate-700"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
