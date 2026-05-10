import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { EmptyState } from './ui/EmptyState';

interface ReceiptPrefill {
  vendorDisplayName: string | null;
  total: string | null;
  date: string | null;
  lineItems: Array<{ description: string; amount: string }>;
  notes: string | null;
}

interface BillListRow {
  id: string;
  billNumber: string;
  billDate: string;
  dueDate: string;
  status: 'open' | 'partial' | 'paid' | 'void';
  total: string;
  balanceDue: string;
  vendorId: string;
  vendorName: string;
  voidedAt: string | null;
}

interface Vendor {
  id: string;
  displayName: string;
  defaultTermsDays: number | null;
  isActive: boolean;
}

interface Account {
  id: string;
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  isActive: boolean;
}

interface LineDraft {
  accountId: string;
  description: string;
  quantity: string;
  unitPrice: string;
}

interface CreateBody {
  vendorId: string;
  billNumber: string;
  billDate: string;
  dueDate?: string | undefined;
  memo?: string | undefined;
  lines: { accountId: string; description: string; quantity: string; unitPrice: string }[];
}

const today = () => new Date().toISOString().slice(0, 10);
const blankLine = (): LineDraft => ({ accountId: '', description: '', quantity: '1', unitPrice: '' });

const STATUS_COLOR: Record<BillListRow['status'], string> = {
  open: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  partial: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  paid: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  void: 'bg-slate-100 text-slate-500 ring-slate-300',
};

function addCents(a: string, b: string): string {
  const toMicros = (s: string) => {
    if (!s) return 0n;
    const [whole = '0', frac = ''] = s.replace(/,/g, '').split('.');
    const padded = (frac + '0000').slice(0, 4);
    const sign = whole.startsWith('-') ? -1n : 1n;
    const wholeAbs = whole.replace(/^-/, '');
    return sign * (BigInt(wholeAbs || '0') * 10000n + BigInt(padded || '0'));
  };
  const sum = toMicros(a) + toMicros(b);
  const negative = sum < 0n;
  const abs = negative ? -sum : sum;
  const whole = abs / 10000n;
  const frac = abs % 10000n;
  return `${negative ? '-' : ''}${whole}.${String(frac).padStart(4, '0')}`;
}

function mulQtyPrice(qty: string, price: string): string {
  if (!qty || !price) return '0';
  const q = Number(qty);
  const p = Number(price);
  if (!Number.isFinite(q) || !Number.isFinite(p)) return '0';
  const qMicros = BigInt(Math.round(q * 10000));
  const pMicros = BigInt(Math.round(p * 10000));
  const product = qMicros * pMicros;
  const scaled = product / 10000n;
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / 10000n;
  const frac = abs % 10000n;
  return `${negative ? '-' : ''}${whole}.${String(frac).padStart(4, '0')}`;
}

function formatUsd(s: string): string {
  if (!s) return '$0.00';
  const [whole = '0', frac = '0000'] = s.split('.');
  const negative = whole.startsWith('-');
  const abs = negative ? whole.slice(1) : whole;
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${withCommas}.${frac.slice(0, 2)}`;
}

export function BillsList() {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'list' | 'new'>('list');
  const [receiptPrefill, setReceiptPrefill] = useState<ReceiptPrefill | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrPending, setOcrPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const aiStatusQuery = useQuery({
    queryKey: ['chat-ai-status'],
    queryFn: () => api<{ available: boolean }>('/chat/status'),
    staleTime: 60_000,
  });
  const aiAvailable = aiStatusQuery.data?.available ?? false;

  async function handleReceiptFile(file: File) {
    setOcrError(null);
    if (file.size > 7_000_000) {
      setOcrError(`Image is ${(file.size / 1e6).toFixed(1)} MB; resize below ~5 MB.`);
      return;
    }
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowed.includes(file.type)) {
      setOcrError(`Unsupported file type ${file.type}; use jpg / png / gif / webp.`);
      return;
    }
    setOcrPending(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.split(',')[1] ?? '';
      const result = await api<{
        vendor: string | null;
        total: string | null;
        date: string | null;
        lineItems: Array<{ description: string; amount: string }>;
        notAReceipt: boolean;
        notes: string | null;
      }>('/ai/extract-receipt', {
        method: 'POST',
        body: { imageBase64: base64, mediaType: file.type },
      });
      if (result.notAReceipt) {
        setOcrError(
          `Claude doesn't think that's a receipt${result.notes ? ` (${result.notes})` : ''}.`,
        );
        return;
      }
      setReceiptPrefill({
        vendorDisplayName: result.vendor,
        total: result.total,
        date: result.date,
        lineItems: result.lineItems,
        notes: result.notes,
      });
      setMode('new');
    } catch (err) {
      setOcrError(formatError(err));
    } finally {
      setOcrPending(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  const billsQuery = useQuery({
    queryKey: ['bills', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ bills: BillListRow[] }>('/bills', { companyId }),
  });

  const voidMutation = useMutation({
    mutationFn: async (billId: string) =>
      api<{ id: string; voidedJournalEntryId: string }>(`/bills/${billId}/void`, {
        method: 'POST',
        companyId,
        body: {},
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bills', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['trial-balance', companyId] });
    },
  });

  const list = billsQuery.data?.bills ?? [];

  if (mode === 'new') {
    return (
      <NewBill
        onCancel={() => {
          setMode('list');
          setReceiptPrefill(null);
        }}
        onSaved={() => {
          setMode('list');
          setReceiptPrefill(null);
          void queryClient.invalidateQueries({ queryKey: ['bills', companyId] });
          void queryClient.invalidateQueries({ queryKey: ['trial-balance', companyId] });
        }}
        billCount={list.length}
        prefill={receiptPrefill}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Bills</h2>
          <p className="text-sm text-slate-500">{list.length} on file</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleReceiptFile(f);
            }}
          />
          {aiAvailable && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={ocrPending}
              className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-sm text-violet-700 hover:bg-violet-100 disabled:opacity-50"
              title="Drop a receipt photo and Claude prefills the bill form"
            >
              {ocrPending ? 'Reading receipt…' : '📷 From receipt'}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setReceiptPrefill(null);
              setMode('new');
            }}
            className="whitespace-nowrap rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            + New bill
          </button>
        </div>
      </div>
      {ocrError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {ocrError}
        </div>
      )}

      {billsQuery.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
      {billsQuery.isError && (
        <p className="text-sm text-rose-600">
          {billsQuery.error instanceof Error ? billsQuery.error.message : 'Failed to load bills.'}
        </p>
      )}

      {!billsQuery.isLoading && list.length === 0 && (
        <EmptyState
          icon="receipt"
          title="No bills yet"
          description="Record a vendor bill to track A/P. Posting writes a balanced JE (DR Expense, CR A/P) and the bill stays open until applied payments zero its balance."
          action={{ label: 'New bill', onClick: () => setMode('new') }}
        />
      )}

      {list.length > 0 && (
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Number</th>
                <th className="px-4 py-2 text-left font-medium">Date</th>
                <th className="px-4 py-2 text-left font-medium">Due</th>
                <th className="px-4 py-2 text-left font-medium">Vendor</th>
                <th className="px-4 py-2 text-center font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 text-right font-medium">Balance</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {list.map((b) => (
                <tr key={b.id} className={b.status === 'void' ? 'opacity-60' : ''}>
                  <td className="px-4 py-2 font-mono text-slate-900">{b.billNumber}</td>
                  <td className="px-4 py-2 text-slate-700">{b.billDate}</td>
                  <td className="px-4 py-2 text-slate-700">{b.dueDate}</td>
                  <td className="px-4 py-2 text-slate-900">{b.vendorName}</td>
                  <td className="px-4 py-2 text-center">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_COLOR[b.status]}`}
                    >
                      {b.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-slate-900">{formatUsd(b.total)}</td>
                  <td className="px-4 py-2 text-right font-mono text-slate-700">
                    {b.status === 'void' ? '—' : formatUsd(b.balanceDue)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {b.status !== 'void' && (
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            confirm(`Void bill ${b.billNumber}? A reversing journal entry will be posted.`)
                          ) {
                            voidMutation.mutate(b.id);
                          }
                        }}
                        disabled={voidMutation.isPending}
                        className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-50"
                      >
                        Void
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {voidMutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {formatError(voidMutation.error)}
        </div>
      )}
    </div>
  );
}

function NewBill({
  onCancel,
  onSaved,
  billCount,
  prefill,
}: {
  onCancel: () => void;
  onSaved: () => void;
  billCount: number;
  prefill: ReceiptPrefill | null;
}) {
  const { companyId } = useCurrentCompany();

  const vendorsQuery = useQuery({
    queryKey: ['vendors', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ vendors: Vendor[] }>('/vendors?active=true', { companyId }),
  });
  const accountsQuery = useQuery({
    queryKey: ['accounts', companyId],
    enabled: Boolean(companyId),
    queryFn: () => api<{ accounts: Account[] }>('/ledger/accounts?active=true', { companyId }),
  });

  const vendors = useMemo(
    () => (vendorsQuery.data?.vendors ?? []).filter((v) => v.isActive),
    [vendorsQuery.data],
  );
  // For a bill, the line accounts are typically expense (or fixed-asset, prepaid, COGS).
  // Show all expense + asset accounts; users can pick what fits.
  const lineAccounts = useMemo(
    () =>
      (accountsQuery.data?.accounts ?? [])
        .filter((a) => a.isActive && (a.type === 'expense' || a.type === 'asset'))
        .sort((a, b) => a.code.localeCompare(b.code)),
    [accountsQuery.data],
  );

  // If the receipt OCR provided line items, use them. Else if it provided a
  // total (no line items), seed a single line with that amount + the vendor
  // name as description. Account selection still has to happen by hand.
  const initialLines: LineDraft[] = useMemo(() => {
    if (prefill?.lineItems && prefill.lineItems.length > 0) {
      return prefill.lineItems.map((it) => ({
        accountId: '',
        description: it.description,
        quantity: '1',
        unitPrice: it.amount,
      }));
    }
    if (prefill?.total) {
      return [
        {
          accountId: '',
          description: prefill.vendorDisplayName ?? 'Receipt',
          quantity: '1',
          unitPrice: prefill.total,
        },
      ];
    }
    return [blankLine()];
  }, [prefill]);

  // Try to match the OCR'd vendor name against an existing vendor (case-
  // insensitive substring). If we find one, preselect it; otherwise leave
  // blank so the user can pick or create a vendor.
  const matchedVendorId = useMemo(() => {
    if (!prefill?.vendorDisplayName) return '';
    const target = prefill.vendorDisplayName.toLowerCase();
    const exact = vendors.find((v) => v.displayName.toLowerCase() === target);
    if (exact) return exact.id;
    const partial = vendors.find(
      (v) => v.displayName.toLowerCase().includes(target) || target.includes(v.displayName.toLowerCase()),
    );
    return partial?.id ?? '';
  }, [prefill, vendors]);

  const [draft, setDraft] = useState<{
    vendorId: string;
    billNumber: string;
    billDate: string;
    dueDate: string;
    memo: string;
    lines: LineDraft[];
  }>(() => ({
    vendorId: matchedVendorId,
    billNumber: `BILL-${1001 + billCount}`,
    billDate: prefill?.date ?? today(),
    dueDate: '',
    memo: prefill?.notes ? `From receipt: ${prefill.notes}` : '',
    lines: initialLines,
  }));

  // Vendors load async; if the matched id resolves after initial render and
  // the user hasn't picked one yet, snap to it.
  useEffect(() => {
    if (matchedVendorId && !draft.vendorId) {
      setDraft((d) => ({ ...d, vendorId: matchedVendorId }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedVendorId]);

  const selectedVendor = useMemo(
    () => vendors.find((v) => v.id === draft.vendorId),
    [vendors, draft.vendorId],
  );

  const computedDueDate = useMemo(() => {
    if (draft.dueDate) return draft.dueDate;
    if (!selectedVendor?.defaultTermsDays || !draft.billDate) return draft.billDate;
    const d = new Date(draft.billDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + selectedVendor.defaultTermsDays);
    return d.toISOString().slice(0, 10);
  }, [draft.dueDate, draft.billDate, selectedVendor]);

  function updateLine(idx: number, patch: Partial<LineDraft>) {
    setDraft((d) => ({
      ...d,
      lines: d.lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
    }));
  }
  function addLine() {
    setDraft((d) => ({ ...d, lines: [...d.lines, blankLine()] }));
  }
  function removeLine(idx: number) {
    setDraft((d) => ({
      ...d,
      lines: d.lines.length <= 1 ? d.lines : d.lines.filter((_, i) => i !== idx),
    }));
  }

  const computedLineAmounts = draft.lines.map((l) => mulQtyPrice(l.quantity, l.unitPrice));
  const subtotal = computedLineAmounts.reduce((acc, amt) => addCents(acc, amt), '0');

  const allLinesValid = draft.lines.every(
    (l, i) =>
      l.accountId && l.description.trim() && Number(computedLineAmounts[i] ?? '0') > 0,
  );
  const canSubmit =
    Boolean(draft.vendorId) &&
    Boolean(draft.billNumber.trim()) &&
    Number(subtotal) > 0 &&
    allLinesValid;

  const mutation = useMutation({
    mutationFn: async () => {
      const body: CreateBody = {
        vendorId: draft.vendorId,
        billNumber: draft.billNumber.trim(),
        billDate: draft.billDate,
        dueDate: draft.dueDate ? draft.dueDate : undefined,
        memo: draft.memo.trim() ? draft.memo.trim() : undefined,
        lines: draft.lines.map((l) => ({
          accountId: l.accountId,
          description: l.description.trim(),
          quantity: l.quantity || '1',
          unitPrice: l.unitPrice || '0',
        })),
      };
      return api<{ id: string; postedJournalEntryId: string; total: string }>('/bills', {
        method: 'POST',
        companyId,
        body,
      });
    },
    onSuccess: () => onSaved(),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || mutation.isPending) return;
    mutation.mutate();
  }

  if (vendorsQuery.isLoading || accountsQuery.isLoading) {
    return <p className="text-sm text-slate-500">Loading…</p>;
  }
  if (vendors.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">New Bill</h2>
          <button type="button" onClick={onCancel} className="text-sm text-slate-600 hover:text-slate-900">
            Cancel
          </button>
        </div>
        <p className="text-sm text-slate-500">
          You need at least one active vendor before creating a bill. Add one in the Vendors tab.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">New Bill</h2>
        <button type="button" onClick={onCancel} className="text-sm text-slate-600 hover:text-slate-900">
          Cancel
        </button>
      </div>

      {prefill && (
        <div className="rounded-md border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-800">
          <p className="font-medium">📷 Prefilled from receipt by Claude.</p>
          <p className="mt-0.5 text-xs">
            Review the vendor + line accounts before saving (Claude doesn't pick GL accounts).
            {prefill.notes && (
              <>
                {' '}
                Note: <span className="italic">{prefill.notes}</span>
              </>
            )}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Vendor" required>
          <select
            value={draft.vendorId}
            onChange={(e) => setDraft({ ...draft, vendorId: e.target.value })}
            required
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
          >
            <option value="">— select vendor —</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.displayName}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Bill #" required>
          <input
            type="text"
            value={draft.billNumber}
            onChange={(e) => setDraft({ ...draft, billNumber: e.target.value })}
            maxLength={40}
            required
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          />
        </Field>
        <Field label="Date" required>
          <input
            type="date"
            value={draft.billDate}
            onChange={(e) => setDraft({ ...draft, billDate: e.target.value })}
            required
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          />
        </Field>
        <Field label="Due date">
          <input
            type="date"
            value={draft.dueDate}
            onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
            placeholder={computedDueDate}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          />
          {!draft.dueDate && computedDueDate !== draft.billDate && (
            <p className="text-xs text-slate-500">Defaulting to {computedDueDate} (vendor's terms).</p>
          )}
        </Field>
        <Field label="Memo">
          <input
            type="text"
            value={draft.memo}
            onChange={(e) => setDraft({ ...draft, memo: e.target.value })}
            maxLength={500}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 sm:col-span-2"
          />
        </Field>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-slate-700">Lines</h3>
          <button
            type="button"
            onClick={addLine}
            className="rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-slate-800"
          >
            + Add line
          </button>
        </div>
        <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Description</th>
                <th className="px-3 py-2 text-left font-medium">Account</th>
                <th className="px-3 py-2 text-right font-medium">Qty</th>
                <th className="px-3 py-2 text-right font-medium">Unit price</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {draft.lines.map((line, idx) => (
                <tr key={idx}>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={line.description}
                      onChange={(e) => updateLine(idx, { description: e.target.value })}
                      maxLength={500}
                      placeholder="Office supplies"
                      className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={line.accountId}
                      onChange={(e) => updateLine(idx, { accountId: e.target.value })}
                      required
                      className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
                    >
                      <option value="">— account —</option>
                      {lineAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.code} — {a.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(e) => updateLine(idx, { quantity: e.target.value.replace(/[^0-9.]/g, '') })}
                      className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-right font-mono text-sm focus:border-slate-900 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      value={line.unitPrice}
                      onChange={(e) => updateLine(idx, { unitPrice: e.target.value.replace(/[^0-9.]/g, '') })}
                      placeholder="0.00"
                      className="w-28 rounded-md border border-slate-300 px-2 py-1.5 text-right font-mono text-sm focus:border-slate-900 focus:outline-none"
                    />
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-slate-900">
                    {formatUsd(computedLineAmounts[idx] ?? '0')}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => removeLine(idx)}
                      disabled={draft.lines.length <= 1}
                      className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-30"
                      aria-label="Remove line"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 text-sm font-medium">
              <tr>
                <td colSpan={4} className="px-3 py-2 text-right text-slate-600">
                  Subtotal
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-900">{formatUsd(subtotal)}</td>
                <td></td>
              </tr>
              <tr>
                <td colSpan={4} className="px-3 py-2 text-right text-slate-700">
                  Total
                </td>
                <td className="px-3 py-2 text-right font-mono text-slate-900">{formatUsd(subtotal)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!canSubmit || mutation.isPending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {mutation.isPending ? 'Posting…' : 'Save & post bill'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>

      {mutation.isError && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          {formatError(mutation.error)}
        </div>
      )}
    </form>
  );
}

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
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? 'Error'}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : 'Operation failed.';
}
