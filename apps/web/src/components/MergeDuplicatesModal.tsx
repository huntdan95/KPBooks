import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type MergeKind = 'customer' | 'vendor';

interface Counterparty {
  id: string;
  displayName: string;
  companyName?: string | null;
  email?: string | null;
  phone?: string | null;
  isActive: boolean;
}

interface MergeResult {
  loserId: string;
  loserName: string;
  winnerId: string;
  winnerName: string;
  reassigned: Record<string, number>;
}

const KIND_LABEL: Record<MergeKind, { singular: string; plural: string; endpoint: string }> = {
  customer: { singular: 'customer', plural: 'customers', endpoint: '/customers' },
  vendor: { singular: 'vendor', plural: 'vendors', endpoint: '/vendors' },
};

/**
 * Modal for merging two duplicate customers or vendors. Picks a "loser" and
 * a "winner": the loser's invoices/bills/payments/etc. all transfer to the
 * winner, then the loser is deleted. Irreversible -- the modal forces the
 * user to confirm + type the loser's name to proceed.
 */
export function MergeDuplicatesModal({
  kind,
  onClose,
}: {
  kind: MergeKind;
  onClose: () => void;
}) {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const labels = KIND_LABEL[kind];

  const [loserId, setLoserId] = useState<string>('');
  const [winnerId, setWinnerId] = useState<string>('');
  const [confirmText, setConfirmText] = useState<string>('');
  const [showConfirm, setShowConfirm] = useState<boolean>(false);
  const [result, setResult] = useState<MergeResult | null>(null);

  const listKey = kind === 'customer' ? ['customers'] : ['vendors'];
  const listQ = useQuery({
    queryKey: [...listKey, companyId],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ rows?: Counterparty[]; customers?: Counterparty[]; vendors?: Counterparty[] } | Counterparty[]>(
        labels.endpoint,
        { companyId },
      ),
  });

  // The list endpoints have slightly different response shapes; normalize.
  const all: Counterparty[] = (() => {
    const d = listQ.data;
    if (!d) return [];
    if (Array.isArray(d)) return d;
    return (d.rows ?? d.customers ?? d.vendors ?? []) as Counterparty[];
  })();
  const sorted = [...all].sort((a, b) =>
    a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase()),
  );
  const loser = sorted.find((c) => c.id === loserId);
  const winner = sorted.find((c) => c.id === winnerId);

  const mutation = useMutation({
    mutationFn: async () => {
      return api<MergeResult>(`${labels.endpoint}/merge`, {
        method: 'POST',
        companyId,
        body: { loserId, winnerId },
      });
    },
    onSuccess: (data) => {
      setResult(data);
      // Invalidate the list so the loser disappears.
      void queryClient.invalidateQueries({ queryKey: [...listKey, companyId] });
      // Also invalidate any related queries (invoices, payments, bills) so
      // counts/links update everywhere.
      if (kind === 'customer') {
        void queryClient.invalidateQueries({ queryKey: ['invoices', companyId] });
        void queryClient.invalidateQueries({ queryKey: ['estimates', companyId] });
      } else {
        void queryClient.invalidateQueries({ queryKey: ['bills', companyId] });
        void queryClient.invalidateQueries({ queryKey: ['payroll-runs', companyId] });
      }
      void queryClient.invalidateQueries({ queryKey: ['payments', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['recurring', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['activity', companyId] });
    },
  });

  const canSubmit =
    Boolean(loserId) &&
    Boolean(winnerId) &&
    loserId !== winnerId &&
    confirmText.trim() === (loser?.displayName ?? '');

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="my-8 w-full max-w-2xl space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">
              Merge duplicate {labels.plural}
            </h2>
            <p className="text-xs text-slate-500">
              Pick the duplicate to discard ("loser") and the one to keep ("winner"). All of the
              loser's invoices, payments, bills, time entries, and recurring templates transfer
              to the winner; then the loser is deleted. <strong>Irreversible.</strong>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            ✕
          </button>
        </div>

        {result ? (
          <div className="space-y-3">
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              ✓ Merged <strong>{result.loserName}</strong> into{' '}
              <strong>{result.winnerName}</strong>.
            </div>
            <div className="rounded-md border border-slate-200 bg-white p-3">
              <h4 className="text-sm font-medium text-slate-700">Records reassigned</h4>
              <ul className="mt-1 space-y-0.5 text-sm">
                {Object.entries(result.reassigned).map(([table, count]) => (
                  <li key={table} className="flex justify-between font-mono text-xs text-slate-600">
                    <span>{table}</span>
                    <span className="text-slate-900">{count}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={`Loser (will be deleted)`} required>
                <select
                  value={loserId}
                  onChange={(e) => {
                    setLoserId(e.target.value);
                    setConfirmText('');
                    setShowConfirm(false);
                  }}
                  className={inputClass}
                >
                  <option value="">Pick…</option>
                  {sorted.map((c) => (
                    <option key={c.id} value={c.id} disabled={c.id === winnerId}>
                      {c.displayName}
                      {c.isActive ? '' : ' (inactive)'}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={`Winner (will keep all records)`} required>
                <select
                  value={winnerId}
                  onChange={(e) => {
                    setWinnerId(e.target.value);
                    setShowConfirm(false);
                  }}
                  className={inputClass}
                >
                  <option value="">Pick…</option>
                  {sorted.map((c) => (
                    <option key={c.id} value={c.id} disabled={c.id === loserId}>
                      {c.displayName}
                      {c.isActive ? '' : ' (inactive)'}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {loser && winner && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wider text-rose-600">
                      Loser → discard
                    </div>
                    <div className="mt-0.5 font-medium text-slate-900">{loser.displayName}</div>
                    {loser.companyName && (
                      <div className="text-xs text-slate-500">{loser.companyName}</div>
                    )}
                    {loser.email && <div className="text-xs text-slate-500">{loser.email}</div>}
                    {loser.phone && <div className="text-xs text-slate-500">{loser.phone}</div>}
                  </div>
                  <div>
                    <div className="text-xs font-medium uppercase tracking-wider text-emerald-700">
                      Winner → keep
                    </div>
                    <div className="mt-0.5 font-medium text-slate-900">{winner.displayName}</div>
                    {winner.companyName && (
                      <div className="text-xs text-slate-500">{winner.companyName}</div>
                    )}
                    {winner.email && (
                      <div className="text-xs text-slate-500">{winner.email}</div>
                    )}
                    {winner.phone && (
                      <div className="text-xs text-slate-500">{winner.phone}</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {!showConfirm && (
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => setShowConfirm(true)}
                  disabled={!loserId || !winnerId || loserId === winnerId}
                  className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Continue
                </button>
              </div>
            )}

            {showConfirm && loser && (
              <div className="space-y-3 rounded-md border border-rose-200 bg-rose-50 p-3">
                <div className="text-sm text-rose-900">
                  <strong>This is irreversible.</strong> Type{' '}
                  <code className="rounded bg-white px-1 font-mono text-rose-800">
                    {loser.displayName}
                  </code>{' '}
                  below to confirm.
                </div>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  className={inputClass}
                  placeholder={loser.displayName}
                  autoFocus
                />
                <div className="flex items-center justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setShowConfirm(false);
                      setConfirmText('');
                    }}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-100"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => mutation.mutate()}
                    disabled={!canSubmit || mutation.isPending}
                    className="rounded-md bg-rose-700 px-4 py-2 text-sm font-medium text-white hover:bg-rose-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {mutation.isPending ? 'Merging…' : 'Merge — discard loser'}
                  </button>
                </div>
                {mutation.isError && (
                  <div className="rounded-md border border-rose-300 bg-white px-3 py-2 text-sm text-rose-800">
                    {formatError(mutation.error)}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
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
