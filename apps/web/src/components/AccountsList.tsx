import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  subtype: string;
  isActive: boolean;
}

const TYPE_LABEL: Record<Account['type'], string> = {
  asset: 'Asset',
  liability: 'Liability',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expense',
};

const TYPE_COLOR: Record<Account['type'], string> = {
  asset: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  liability: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  equity: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  revenue: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  expense: 'bg-rose-50 text-rose-700 ring-rose-600/20',
};

export function AccountsList() {
  const { companyId } = useCurrentCompany();

  const query = useQuery({
    queryKey: ['accounts', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ accounts: Account[] }>('/ledger/accounts', { companyId }),
  });

  if (query.isLoading) {
    return <p className="text-sm text-slate-500">Loading accounts…</p>;
  }
  if (query.isError) {
    return (
      <p className="text-sm text-red-600">
        {query.error instanceof Error ? query.error.message : 'Failed to load accounts.'}
      </p>
    );
  }

  const accounts = query.data?.accounts ?? [];
  if (accounts.length === 0) {
    return (
      <p className="text-sm text-slate-500">No accounts yet. Try creating a new company.</p>
    );
  }

  // Group accounts by type so the list reads like a real COA.
  const sorted = [...accounts].sort((a, b) => a.code.localeCompare(b.code));
  const byType = sorted.reduce<Record<string, Account[]>>((acc, a) => {
    (acc[a.type] ??= []).push(a);
    return acc;
  }, {});
  const order: Account['type'][] = ['asset', 'liability', 'equity', 'revenue', 'expense'];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Chart of Accounts</h2>
        <span className="text-sm text-slate-500">{accounts.length} accounts</span>
      </div>
      {order.map((type) => {
        const group = byType[type];
        if (!group?.length) return null;
        return (
          <section key={type} className="space-y-2">
            <h3 className="text-sm font-medium text-slate-700">{TYPE_LABEL[type]}</h3>
            <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
              {group.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between px-4 py-2.5 text-sm"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-slate-500">{a.code}</span>
                    <span className="font-medium text-slate-900">{a.name}</span>
                  </div>
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TYPE_COLOR[a.type]}`}
                  >
                    {a.subtype.replace(/_/g, ' ')}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
