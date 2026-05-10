import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { EmptyState } from './ui/EmptyState';
import { Icon } from './ui/Icon';

type TripStatus = 'logged' | 'posted';

interface TripRow {
  id: string;
  tripDate: string;
  startLocation: string | null;
  endLocation: string | null;
  vehicle: string | null;
  miles: string;
  purpose: string;
  ratePerMile: string;
  deduction: string;
  status: TripStatus;
  postedAt: string | null;
  postedJournalEntryId: string | null;
}

interface CompanyCurrent {
  id: string;
  name: string;
  mileageRateDefault: string;
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
const firstOfMonth = () => {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

function formatUsd(s: string | number | null | undefined): string {
  if (s === null || s === undefined || s === '') return '$0.00';
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n)) return '$0.00';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatMiles(s: string | number): string {
  const n = typeof s === 'number' ? s : Number(s);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

const STATUS_TONE: Record<TripStatus, string> = {
  logged: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  posted: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
};

export function Mileage() {
  const { companyId } = useCurrentCompany();
  const [showWizard, setShowWizard] = useState(false);
  const [showPost, setShowPost] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const tripsQ = useQuery({
    queryKey: ['mileage-trips', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ trips: TripRow[] }>('/mileage-trips', { companyId }),
  });

  const companyQ = useQuery({
    queryKey: ['company-current', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<CompanyCurrent>('/companies/current', { companyId }),
  });

  const trips = tripsQ.data?.trips ?? [];
  const logged = trips.filter((t) => t.status === 'logged');
  const posted = trips.filter((t) => t.status === 'posted');
  const loggedTotalDeduction = logged.reduce((acc, t) => acc + Number(t.deduction), 0);
  const loggedTotalMiles = logged.reduce((acc, t) => acc + Number(t.miles), 0);
  const editingTrip = editingId ? trips.find((t) => t.id === editingId) ?? null : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Mileage</h2>
          <p className="text-sm text-slate-500">
            Log business trips with the IRS standard mileage rate, then batch-post a date range
            to a journal entry (DR Vehicle/Mileage Expense, CR Owner Reimbursement). The rate at
            log time is locked on the trip — IRS rate changes won't silently shift past
            deductions.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowPost((v) => !v)}
            disabled={logged.length === 0}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            title={
              logged.length === 0 ? 'No logged trips to post' : 'Post a date range to a JE'
            }
          >
            <Icon name="upload-cloud" className="h-3.5 w-3.5" />
            {showPost ? 'Cancel' : 'Post mileage…'}
          </button>
          <button
            type="button"
            onClick={() => setShowWizard((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            <Icon name="plus" className="h-3.5 w-3.5" strokeWidth={2.25} />
            {showWizard ? 'Cancel' : 'New trip'}
          </button>
        </div>
      </div>

      {/* Summary tiles */}
      {logged.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Tile
            label="Logged trips"
            value={String(logged.length)}
            hint="ready to post"
            tone="amber"
          />
          <Tile
            label="Total miles (logged)"
            value={formatMiles(loggedTotalMiles)}
            hint="across logged trips"
            tone="slate"
          />
          <Tile
            label="Total deduction"
            value={formatUsd(loggedTotalDeduction)}
            hint="at locked rates"
            tone="emerald"
          />
        </div>
      )}

      {showWizard && (
        <NewTripWizard
          defaultRate={companyQ.data?.mileageRateDefault ?? '0.670000'}
          onCreated={() => setShowWizard(false)}
        />
      )}

      {showPost && (
        <PostMileagePanel
          onDone={() => setShowPost(false)}
          loggedCount={logged.length}
        />
      )}

      {editingTrip && (
        <EditTripModal trip={editingTrip} onClose={() => setEditingId(null)} />
      )}

      {tripsQ.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {tripsQ.isError && (
        <p className="text-sm text-rose-600">
          {tripsQ.error instanceof Error ? tripsQ.error.message : 'Failed to load.'}
        </p>
      )}

      {!tripsQ.isLoading && trips.length === 0 && (
        <EmptyState
          icon="car"
          title="No trips logged yet"
          description="Log your first business trip — the form pre-fills with the current IRS standard mileage rate. Posting batches all logged trips in a date range into one journal entry."
          action={{ label: 'New trip', onClick: () => setShowWizard(true) }}
        />
      )}

      {logged.length > 0 && (
        <TripsTable
          rows={logged}
          title="Logged"
          onEdit={(id) => setEditingId(id)}
        />
      )}
      {posted.length > 0 && (
        <TripsTable rows={posted} title="Posted" onEdit={null} />
      )}
    </div>
  );
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone: 'slate' | 'emerald' | 'amber' | 'rose';
}) {
  const cls = {
    slate: 'border-slate-200 bg-white text-slate-900',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    rose: 'border-rose-200 bg-rose-50 text-rose-700',
  }[tone];
  return (
    <div className={'rounded-md border p-3 ' + cls}>
      <div className="text-xs uppercase tracking-wider opacity-70">{label}</div>
      <div className="mt-1 font-mono text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] opacity-60">{hint}</div>}
    </div>
  );
}

function TripsTable({
  rows,
  title,
  onEdit,
}: {
  rows: TripRow[];
  title: string;
  onEdit: ((id: string) => void) | null;
}) {
  const totalMiles = rows.reduce((acc, r) => acc + Number(r.miles), 0);
  const totalDeduction = rows.reduce((acc, r) => acc + Number(r.deduction), 0);
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">
        {title} ({rows.length})
      </h3>
      <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Date</th>
              <th className="px-4 py-2 text-left font-medium">Vehicle</th>
              <th className="px-4 py-2 text-left font-medium">Trip</th>
              <th className="px-4 py-2 text-left font-medium">Purpose</th>
              <th className="px-4 py-2 text-right font-medium">Miles</th>
              <th className="px-4 py-2 text-right font-medium">Rate</th>
              <th className="px-4 py-2 text-right font-medium">Deduction</th>
              <th className="px-4 py-2 text-left font-medium">Status</th>
              {onEdit && <th className="px-4 py-2"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="px-4 py-2 font-mono text-xs text-slate-700">{r.tripDate}</td>
                <td className="px-4 py-2 text-xs text-slate-600">{r.vehicle ?? '—'}</td>
                <td className="px-4 py-2 text-xs text-slate-600">
                  {r.startLocation || r.endLocation ? (
                    <span>
                      {r.startLocation ?? '?'} → {r.endLocation ?? '?'}
                    </span>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="px-4 py-2 text-slate-900">{r.purpose}</td>
                <td className="px-4 py-2 text-right font-mono tabular-nums text-slate-700">
                  {formatMiles(r.miles)}
                </td>
                <td className="px-4 py-2 text-right font-mono text-xs text-slate-500">
                  {Number(r.ratePerMile).toFixed(4)}
                </td>
                <td className="px-4 py-2 text-right font-mono font-semibold tabular-nums text-slate-900">
                  {formatUsd(r.deduction)}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={
                      'inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ring-1 ring-inset ' +
                      STATUS_TONE[r.status]
                    }
                  >
                    {r.status}
                  </span>
                </td>
                {onEdit && (
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onEdit(r.id)}
                      className="text-xs text-slate-600 hover:text-slate-900 hover:underline"
                    >
                      Edit
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-slate-100 text-sm font-semibold">
            <tr>
              <td colSpan={4} className="px-4 py-3 text-right text-slate-900">
                Total
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-700">
                {formatMiles(totalMiles)}
              </td>
              <td className="px-4 py-3 text-right text-xs text-slate-400 italic">—</td>
              <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-900">
                {formatUsd(totalDeduction)}
              </td>
              <td colSpan={onEdit ? 2 : 1}></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// --- New trip wizard ------------------------------------------------------

interface TripDraft {
  tripDate: string;
  startLocation: string;
  endLocation: string;
  vehicle: string;
  miles: string;
  ratePerMile: string;
  purpose: string;
  notes: string;
  startOdometer: string;
  endOdometer: string;
}

const emptyDraft = (defaultRate: string): TripDraft => ({
  tripDate: todayIso(),
  startLocation: '',
  endLocation: '',
  vehicle: '',
  miles: '',
  ratePerMile: defaultRate,
  purpose: '',
  notes: '',
  startOdometer: '',
  endOdometer: '',
});

function NewTripWizard({
  defaultRate,
  onCreated,
}: {
  defaultRate: string;
  onCreated: () => void;
}) {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<TripDraft>(() => emptyDraft(defaultRate));

  // If the user enters odometer values, auto-fill miles from the difference.
  const odometerMiles =
    draft.startOdometer && draft.endOdometer
      ? (Number(draft.endOdometer) - Number(draft.startOdometer)).toFixed(1)
      : '';

  const effectiveMiles = draft.miles || odometerMiles;
  const computedDeduction =
    effectiveMiles && draft.ratePerMile
      ? (Number(effectiveMiles) * Number(draft.ratePerMile)).toFixed(4)
      : '0';

  const mutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        tripDate: draft.tripDate,
        miles: effectiveMiles,
        purpose: draft.purpose.trim(),
        ratePerMile: draft.ratePerMile,
      };
      if (draft.startLocation.trim()) body.startLocation = draft.startLocation.trim();
      if (draft.endLocation.trim()) body.endLocation = draft.endLocation.trim();
      if (draft.vehicle.trim()) body.vehicle = draft.vehicle.trim();
      if (draft.notes.trim()) body.notes = draft.notes.trim();
      if (draft.startOdometer) body.startOdometer = draft.startOdometer;
      if (draft.endOdometer) body.endOdometer = draft.endOdometer;
      return api<{ id: string }>('/mileage-trips', {
        method: 'POST',
        companyId,
        body,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mileage-trips', companyId] });
      setDraft(emptyDraft(defaultRate));
      onCreated();
    },
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (mutation.isPending) return;
    if (!effectiveMiles || !draft.purpose.trim()) return;
    mutation.mutate();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-medium text-slate-700">New trip</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Trip date" required>
          <input
            type="date"
            value={draft.tripDate}
            onChange={(e) => setDraft({ ...draft, tripDate: e.target.value })}
            required
            className={inputClass}
          />
        </Field>
        <Field label="Vehicle">
          <input
            type="text"
            value={draft.vehicle}
            onChange={(e) => setDraft({ ...draft, vehicle: e.target.value })}
            maxLength={120}
            placeholder="2022 F-150"
            className={inputClass}
          />
        </Field>
        <Field label={`Rate per mile (default ${Number(defaultRate).toFixed(4)})`} required>
          <input
            type="text"
            inputMode="decimal"
            value={draft.ratePerMile}
            onChange={(e) => setDraft({ ...draft, ratePerMile: e.target.value })}
            required
            className={inputClass + ' font-mono'}
          />
        </Field>
        <Field label="Start location">
          <input
            type="text"
            value={draft.startLocation}
            onChange={(e) => setDraft({ ...draft, startLocation: e.target.value })}
            maxLength={200}
            placeholder="Office"
            className={inputClass}
          />
        </Field>
        <Field label="End location">
          <input
            type="text"
            value={draft.endLocation}
            onChange={(e) => setDraft({ ...draft, endLocation: e.target.value })}
            maxLength={200}
            placeholder="Client site"
            className={inputClass}
          />
        </Field>
        <Field label="Purpose" required>
          <input
            type="text"
            value={draft.purpose}
            onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
            required
            maxLength={500}
            placeholder="Q3 review meeting"
            className={inputClass}
          />
        </Field>
        <Field label="Start odometer (optional)">
          <input
            type="text"
            inputMode="decimal"
            value={draft.startOdometer}
            onChange={(e) => setDraft({ ...draft, startOdometer: e.target.value })}
            placeholder="12345.0"
            className={inputClass + ' font-mono'}
          />
        </Field>
        <Field label="End odometer (optional)">
          <input
            type="text"
            inputMode="decimal"
            value={draft.endOdometer}
            onChange={(e) => setDraft({ ...draft, endOdometer: e.target.value })}
            placeholder="12389.5"
            className={inputClass + ' font-mono'}
          />
        </Field>
        <Field label={odometerMiles ? `Miles (auto: ${odometerMiles})` : 'Miles'} required>
          <input
            type="text"
            inputMode="decimal"
            value={draft.miles}
            onChange={(e) => setDraft({ ...draft, miles: e.target.value })}
            required={!odometerMiles}
            placeholder={odometerMiles || '44.5'}
            className={inputClass + ' font-mono'}
          />
        </Field>
      </div>
      <Field label="Notes">
        <textarea
          value={draft.notes}
          onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          maxLength={2000}
          rows={2}
          className={inputClass}
        />
      </Field>

      <div className="flex items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-2">
        <div className="text-xs text-slate-500">
          {effectiveMiles && draft.ratePerMile ? (
            <>
              Deduction: <strong className="font-mono text-slate-900">{formatUsd(computedDeduction)}</strong>{' '}
              ({effectiveMiles} mi × {Number(draft.ratePerMile).toFixed(4)})
            </>
          ) : (
            <span className="italic">Fill in miles + rate to preview the deduction.</span>
          )}
        </div>
        <button
          type="submit"
          disabled={mutation.isPending || !effectiveMiles || !draft.purpose.trim()}
          className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation.isPending ? 'Saving…' : 'Save trip'}
        </button>
      </div>

      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {formatError(mutation.error)}
        </div>
      )}
    </form>
  );
}

// --- Edit trip modal -------------------------------------------------------

function EditTripModal({ trip, onClose }: { trip: TripRow; onClose: () => void }) {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({
    tripDate: trip.tripDate,
    startLocation: trip.startLocation ?? '',
    endLocation: trip.endLocation ?? '',
    vehicle: trip.vehicle ?? '',
    miles: trip.miles,
    ratePerMile: trip.ratePerMile,
    purpose: trip.purpose,
  });

  const updateMut = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        tripDate: draft.tripDate,
        miles: draft.miles,
        ratePerMile: draft.ratePerMile,
        purpose: draft.purpose.trim(),
        startLocation: draft.startLocation.trim() || null,
        endLocation: draft.endLocation.trim() || null,
        vehicle: draft.vehicle.trim() || null,
      };
      return api(`/mileage-trips/${trip.id}`, { method: 'PATCH', companyId, body });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mileage-trips', companyId] });
      onClose();
    },
  });

  const deleteMut = useMutation({
    mutationFn: async () =>
      api(`/mileage-trips/${trip.id}`, { method: 'DELETE', companyId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mileage-trips', companyId] });
      onClose();
    },
  });

  return (
    <div
      className="kpb-fade-in fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="kpb-pop-in my-8 w-full max-w-xl space-y-3 rounded-lg border border-slate-200 bg-white p-6 shadow-xl shadow-slate-900/10">
        <div className="flex items-start justify-between">
          <h3 className="text-base font-semibold text-slate-900">Edit trip</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100"
          >
            ✕
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Trip date" required>
            <input
              type="date"
              value={draft.tripDate}
              onChange={(e) => setDraft({ ...draft, tripDate: e.target.value })}
              required
              className={inputClass}
            />
          </Field>
          <Field label="Vehicle">
            <input
              type="text"
              value={draft.vehicle}
              onChange={(e) => setDraft({ ...draft, vehicle: e.target.value })}
              maxLength={120}
              className={inputClass}
            />
          </Field>
          <Field label="Miles" required>
            <input
              type="text"
              inputMode="decimal"
              value={draft.miles}
              onChange={(e) => setDraft({ ...draft, miles: e.target.value })}
              required
              className={inputClass + ' font-mono'}
            />
          </Field>
          <Field label="Rate per mile" required>
            <input
              type="text"
              inputMode="decimal"
              value={draft.ratePerMile}
              onChange={(e) => setDraft({ ...draft, ratePerMile: e.target.value })}
              required
              className={inputClass + ' font-mono'}
            />
          </Field>
          <Field label="Start location">
            <input
              type="text"
              value={draft.startLocation}
              onChange={(e) => setDraft({ ...draft, startLocation: e.target.value })}
              maxLength={200}
              className={inputClass}
            />
          </Field>
          <Field label="End location">
            <input
              type="text"
              value={draft.endLocation}
              onChange={(e) => setDraft({ ...draft, endLocation: e.target.value })}
              maxLength={200}
              className={inputClass}
            />
          </Field>
        </div>
        <Field label="Purpose" required>
          <input
            type="text"
            value={draft.purpose}
            onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
            required
            maxLength={500}
            className={inputClass}
          />
        </Field>

        <div className="flex items-center justify-between pt-2">
          <button
            type="button"
            onClick={() => {
              if (confirm('Delete this trip?')) deleteMut.mutate();
            }}
            disabled={deleteMut.isPending}
            className="rounded-md border border-rose-200 px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            {deleteMut.isPending ? 'Deleting…' : 'Delete'}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => updateMut.mutate()}
              disabled={updateMut.isPending || !draft.miles || !draft.purpose.trim()}
              className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {updateMut.isPending ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
        {(updateMut.isError || deleteMut.isError) && (
          <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {formatError(updateMut.error ?? deleteMut.error)}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Post mileage panel ----------------------------------------------------

function PostMileagePanel({
  onDone,
  loggedCount,
}: {
  onDone: () => void;
  loggedCount: number;
}) {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [fromDate, setFromDate] = useState<string>(firstOfMonth());
  const [toDate, setToDate] = useState<string>(todayIso());
  const [expenseAccountId, setExpenseAccountId] = useState<string>('');
  const [creditAccountId, setCreditAccountId] = useState<string>('');
  const [memo, setMemo] = useState<string>('');

  const accountsQ = useQuery({
    queryKey: ['accounts', companyId, 'mileage-post'],
    enabled: Boolean(companyId),
    queryFn: () =>
      api<{ accounts: Account[] }>('/ledger/accounts?active=true', { companyId }),
  });
  const accts = accountsQ.data?.accounts ?? [];
  const expenseAccts = accts.filter((a) => a.type === 'expense');
  // Credit account: usually a bank/cash (paid the employee back) or "Owner
  // Reimbursement" liability. Show all liability + asset accounts.
  const creditAccts = accts.filter((a) => a.type === 'asset' || a.type === 'liability');

  const mutation = useMutation({
    mutationFn: async () =>
      api<{
        journalEntryId: string;
        tripCount: number;
        totalMiles: string;
        totalDeduction: string;
      }>('/mileage-trips/post', {
        method: 'POST',
        companyId,
        body: {
          fromDate,
          toDate,
          expenseAccountId,
          creditAccountId,
          memo: memo.trim() || undefined,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mileage-trips', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['activity', companyId] });
    },
  });

  const canPost =
    Boolean(fromDate) &&
    Boolean(toDate) &&
    Boolean(expenseAccountId) &&
    Boolean(creditAccountId);

  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-white p-4">
      <h3 className="text-sm font-medium text-slate-700">Post mileage to GL</h3>
      <p className="text-xs text-slate-500">
        Sums every <strong>logged</strong> trip in the date range and writes ONE journal entry:
        DR {expenseAccts.find((a) => a.id === expenseAccountId)?.name ?? 'Vehicle/Mileage Expense'},
        CR {creditAccts.find((a) => a.id === creditAccountId)?.name ?? 'Owner Reimbursement'}.
        Each posted trip gets stamped with the JE id and locked from edits.{' '}
        {loggedCount} trip(s) currently logged.
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="From date" required>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            required
            className={inputClass}
          />
        </Field>
        <Field label="To date" required>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            required
            className={inputClass}
          />
        </Field>
        <Field label="Expense account (DR)" required>
          <select
            value={expenseAccountId}
            onChange={(e) => setExpenseAccountId(e.target.value)}
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
        <Field label="Credit account (CR)" required>
          <select
            value={creditAccountId}
            onChange={(e) => setCreditAccountId(e.target.value)}
            required
            className={inputClass}
          >
            <option value="">Pick…</option>
            {creditAccts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name} ({a.type})
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Memo (optional)">
        <input
          type="text"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          maxLength={500}
          placeholder={`Mileage reimbursement: ${fromDate} to ${toDate}`}
          className={inputClass}
        />
      </Field>

      {mutation.isSuccess && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          ✓ Posted {mutation.data.tripCount} trip(s): {formatMiles(mutation.data.totalMiles)} mi ={' '}
          {formatUsd(mutation.data.totalDeduction)}.
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={onDone}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
        >
          Close
        </button>
        <button
          type="button"
          onClick={() => mutation.mutate()}
          disabled={!canPost || mutation.isPending}
          className="rounded-md bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation.isPending ? 'Posting…' : 'Post mileage'}
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
