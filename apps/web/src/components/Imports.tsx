import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';

type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
type AccountSubtype =
  | 'bank'
  | 'accounts_receivable'
  | 'other_current_asset'
  | 'fixed_asset'
  | 'other_asset'
  | 'accounts_payable'
  | 'credit_card'
  | 'other_current_liability'
  | 'long_term_liability'
  | 'equity'
  | 'retained_earnings'
  | 'income'
  | 'other_income'
  | 'expense'
  | 'cost_of_goods_sold'
  | 'other_expense';

interface ParsedAccount {
  name: string;
  qbType: string;
  type: AccountType;
  subtype: AccountSubtype;
  description?: string;
  suggestedCode: string;
}
interface ParsedCustomer {
  displayName: string;
  companyName?: string;
  email?: string;
  phone?: string;
  notes?: string;
  defaultTermsDays?: number;
}
interface ParsedVendor {
  displayName: string;
  companyName?: string;
  email?: string;
  phone?: string;
  notes?: string;
  defaultTermsDays?: number;
  is1099Vendor: boolean;
  taxId?: string;
}
interface IifPreview {
  accounts: ParsedAccount[];
  customers: ParsedCustomer[];
  vendors: ParsedVendor[];
  unrecognizedSections: string[];
  warnings: string[];
}
interface CommitResult {
  accountsCreated: number;
  accountsSkipped: number;
  customersCreated: number;
  customersSkipped: number;
  vendorsCreated: number;
  vendorsSkipped: number;
  conflicts: { kind: 'account' | 'customer' | 'vendor'; identifier: string; reason: string }[];
}

type Stage = 'upload' | 'preview' | 'committed';

export function Imports() {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>('upload');
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<IifPreview | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<CommitResult | null>(null);
  // Per-row include flags so users can opt rows out before commit.
  const [accountInclude, setAccountInclude] = useState<boolean[]>([]);
  const [customerInclude, setCustomerInclude] = useState<boolean[]>([]);
  const [vendorInclude, setVendorInclude] = useState<boolean[]>([]);

  const previewMutation = useMutation({
    mutationFn: async (text: string) =>
      api<IifPreview>('/imports/iif/preview', { method: 'POST', companyId, body: { text } }),
    onSuccess: (data) => {
      setPreview(data);
      setAccountInclude(data.accounts.map(() => true));
      setCustomerInclude(data.customers.map(() => true));
      setVendorInclude(data.vendors.map(() => true));
      setStage('preview');
    },
    onError: (err) => {
      setParseError(formatError(err));
    },
  });

  const commitMutation = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error('no preview');
      const accounts = preview.accounts
        .filter((_, i) => accountInclude[i])
        .map((a) => ({
          name: a.name,
          type: a.type,
          subtype: a.subtype,
          code: a.suggestedCode,
          ...(a.description ? { description: a.description } : {}),
        }));
      const customers = preview.customers
        .filter((_, i) => customerInclude[i])
        .map((c) => stripUndef(c));
      const vendors = preview.vendors
        .filter((_, i) => vendorInclude[i])
        .map((v) => stripUndef(v));
      return api<CommitResult>('/imports/iif/commit', {
        method: 'POST',
        companyId,
        body: { accounts, customers, vendors },
      });
    },
    onSuccess: (data) => {
      setCommitted(data);
      setStage('committed');
      // Refresh downstream lists.
      void queryClient.invalidateQueries({ queryKey: ['accounts', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['customers', companyId] });
      void queryClient.invalidateQueries({ queryKey: ['vendors', companyId] });
    },
  });

  function reset() {
    setStage('upload');
    setFileName(null);
    setPreview(null);
    setParseError(null);
    setCommitted(null);
    setAccountInclude([]);
    setCustomerInclude([]);
    setVendorInclude([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleFile(file: File) {
    setFileName(file.name);
    setParseError(null);
    const text = await file.text();
    if (!text.trim()) {
      setParseError('File is empty.');
      return;
    }
    if (text.length > 5_000_000) {
      setParseError(`File is ${(text.length / 1e6).toFixed(1)} MB. The import accepts up to 5 MB.`);
      return;
    }
    previewMutation.mutate(text);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Import from QuickBooks</h2>
        <p className="text-sm text-slate-500">
          Upload an .iif export to bring over your chart of accounts, customers, and vendors. v1
          only imports lists — historical transactions stay in your QB file as the archive of
          record. Post an opening journal entry once accounts are imported.
        </p>
      </div>

      {stage === 'upload' && (
        <div className="rounded-md border-2 border-dashed border-slate-300 bg-white p-8">
          <input
            ref={fileInputRef}
            type="file"
            accept=".iif,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-slate-600">Drop a .iif file or click below to choose one.</p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={previewMutation.isPending}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {previewMutation.isPending ? 'Parsing…' : 'Choose file'}
            </button>
            {fileName && <p className="text-xs text-slate-500">{fileName}</p>}
            {parseError && <p className="text-sm text-rose-600">{parseError}</p>}
          </div>
        </div>
      )}

      {stage === 'preview' && preview && (
        <div className="space-y-6">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm">
            <p className="font-medium text-slate-900">Preview from {fileName}</p>
            <p className="text-slate-600">
              {preview.accounts.length} accounts · {preview.customers.length} customers ·{' '}
              {preview.vendors.length} vendors
            </p>
            {preview.unrecognizedSections.length > 0 && (
              <p className="mt-1 text-xs text-amber-700">
                Skipped (not yet supported): {preview.unrecognizedSections.join(', ')}
              </p>
            )}
            {preview.warnings.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-slate-700">
                  {preview.warnings.length} parser warning(s)
                </summary>
                <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-slate-600">
                  {preview.warnings.slice(0, 100).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                  {preview.warnings.length > 100 && (
                    <li>… and {preview.warnings.length - 100} more</li>
                  )}
                </ul>
              </details>
            )}
          </div>

          {preview.accounts.length > 0 && (
            <PreviewSection
              title="Chart of Accounts"
              count={preview.accounts.length}
              includeStates={accountInclude}
              setIncludeStates={setAccountInclude}
            >
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="w-10 px-3 py-2"></th>
                    <th className="px-3 py-2 text-left font-medium">Code</th>
                    <th className="px-3 py-2 text-left font-medium">Name</th>
                    <th className="px-3 py-2 text-left font-medium">Type</th>
                    <th className="px-3 py-2 text-left font-medium">QB type</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {preview.accounts.map((a, i) => (
                    <tr key={i} className={accountInclude[i] ? '' : 'opacity-40'}>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={accountInclude[i] ?? true}
                          onChange={(e) => toggleAt(setAccountInclude, i, e.target.checked)}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-slate-500">{a.suggestedCode}</td>
                      <td className="px-3 py-2 text-slate-900">{a.name}</td>
                      <td className="px-3 py-2 text-slate-700">
                        {a.type} · {a.subtype.replace(/_/g, ' ')}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">{a.qbType}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </PreviewSection>
          )}

          {preview.customers.length > 0 && (
            <PreviewSection
              title="Customers"
              count={preview.customers.length}
              includeStates={customerInclude}
              setIncludeStates={setCustomerInclude}
            >
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="w-10 px-3 py-2"></th>
                    <th className="px-3 py-2 text-left font-medium">Display name</th>
                    <th className="px-3 py-2 text-left font-medium">Email</th>
                    <th className="px-3 py-2 text-left font-medium">Phone</th>
                    <th className="px-3 py-2 text-right font-medium">Terms</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {preview.customers.map((c, i) => (
                    <tr key={i} className={customerInclude[i] ? '' : 'opacity-40'}>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={customerInclude[i] ?? true}
                          onChange={(e) => toggleAt(setCustomerInclude, i, e.target.checked)}
                        />
                      </td>
                      <td className="px-3 py-2 text-slate-900">
                        <div className="font-medium">{c.displayName}</div>
                        {c.companyName && <div className="text-xs text-slate-500">{c.companyName}</div>}
                      </td>
                      <td className="px-3 py-2 text-slate-700">{c.email ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-700">{c.phone ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-slate-700">
                        {c.defaultTermsDays === undefined ? '—' : `Net ${c.defaultTermsDays}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </PreviewSection>
          )}

          {preview.vendors.length > 0 && (
            <PreviewSection
              title="Vendors"
              count={preview.vendors.length}
              includeStates={vendorInclude}
              setIncludeStates={setVendorInclude}
            >
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="w-10 px-3 py-2"></th>
                    <th className="px-3 py-2 text-left font-medium">Display name</th>
                    <th className="px-3 py-2 text-left font-medium">Email</th>
                    <th className="px-3 py-2 text-left font-medium">Phone</th>
                    <th className="px-3 py-2 text-right font-medium">Terms</th>
                    <th className="px-3 py-2 text-center font-medium">1099</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {preview.vendors.map((v, i) => (
                    <tr key={i} className={vendorInclude[i] ? '' : 'opacity-40'}>
                      <td className="px-3 py-2 text-center">
                        <input
                          type="checkbox"
                          checked={vendorInclude[i] ?? true}
                          onChange={(e) => toggleAt(setVendorInclude, i, e.target.checked)}
                        />
                      </td>
                      <td className="px-3 py-2 text-slate-900">
                        <div className="font-medium">{v.displayName}</div>
                        {v.companyName && <div className="text-xs text-slate-500">{v.companyName}</div>}
                      </td>
                      <td className="px-3 py-2 text-slate-700">{v.email ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-700">{v.phone ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-slate-700">
                        {v.defaultTermsDays === undefined ? '—' : `Net ${v.defaultTermsDays}`}
                      </td>
                      <td className="px-3 py-2 text-center text-slate-700">
                        {v.is1099Vendor ? '✓' : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </PreviewSection>
          )}

          <div className="flex items-center gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={() => commitMutation.mutate()}
              disabled={commitMutation.isPending}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {commitMutation.isPending ? 'Importing…' : 'Confirm import'}
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>

          {commitMutation.isError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {formatError(commitMutation.error)}
            </div>
          )}
        </div>
      )}

      {stage === 'committed' && committed && (
        <div className="space-y-4">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <p className="font-medium">Import complete.</p>
            <ul className="mt-1 list-disc pl-5">
              <li>
                {committed.accountsCreated} accounts created
                {committed.accountsSkipped > 0 ? `, ${committed.accountsSkipped} skipped` : ''}
              </li>
              <li>
                {committed.customersCreated} customers created
                {committed.customersSkipped > 0 ? `, ${committed.customersSkipped} skipped` : ''}
              </li>
              <li>
                {committed.vendorsCreated} vendors created
                {committed.vendorsSkipped > 0 ? `, ${committed.vendorsSkipped} skipped` : ''}
              </li>
            </ul>
          </div>

          {committed.conflicts.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium">{committed.conflicts.length} skipped due to conflicts:</p>
              <ul className="mt-1 max-h-60 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {committed.conflicts.map((c, i) => (
                  <li key={i}>
                    <span className="font-medium">{c.kind}</span>: {c.identifier} — {c.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
          >
            Import another file
          </button>
        </div>
      )}
    </div>
  );
}

function PreviewSection({
  title,
  count,
  includeStates,
  setIncludeStates,
  children,
}: {
  title: string;
  count: number;
  includeStates: boolean[];
  setIncludeStates: (v: boolean[]) => void;
  children: React.ReactNode;
}) {
  const includedCount = includeStates.filter(Boolean).length;
  const allOn = includedCount === count;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">
          {title}{' '}
          <span className="text-slate-500">
            ({includedCount} of {count} selected)
          </span>
        </h3>
        <button
          type="button"
          onClick={() => setIncludeStates(Array(count).fill(!allOn))}
          className="text-xs text-slate-600 underline hover:text-slate-900"
        >
          {allOn ? 'Deselect all' : 'Select all'}
        </button>
      </div>
      <div className="overflow-hidden rounded-md border border-slate-200 bg-white">{children}</div>
    </section>
  );
}

function toggleAt(
  setter: (v: boolean[] | ((prev: boolean[]) => boolean[])) => void,
  idx: number,
  val: boolean,
) {
  setter((prev) => prev.map((v, i) => (i === idx ? val : v)));
}

function stripUndef<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (body?.message) return `${body.error ?? 'Error'}: ${body.message}`;
    if (body?.error) return body.error;
  }
  return err instanceof Error ? err.message : 'Operation failed.';
}
