import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { decodeIifBuffer } from '../lib/decode-iif';
import {
  assertCommitCompanyUnchanged,
  chunkListsForCommit,
  chunkTransactionsForCommit,
  mergeListsCommitResults,
  mergeTransactionCommitResults,
} from '../lib/iif-commit';
import { mapsToLabel } from '../lib/iif-preview';

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
  /** False when the row is marked HIDDEN=Y (inactive) in QuickBooks. */
  isActive?: boolean;
}
interface ParsedCustomer {
  displayName: string;
  companyName?: string;
  email?: string;
  phone?: string;
  notes?: string;
  defaultTermsDays?: number;
  billingAddress?: Record<string, string>;
  shippingAddress?: Record<string, string>;
  isActive?: boolean;
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
  mailingAddress?: Record<string, string>;
  isActive?: boolean;
}
interface ParsedSplit {
  account: string;
  amount: string;
  name?: string;
  memo?: string;
  classRef?: string;
}
interface ParsedTransaction {
  rowNumber: number;
  qbType: string;
  sourceType:
    | 'invoice'
    | 'bill'
    | 'payment'
    | 'bank_transaction'
    | 'reconciliation'
    | 'payroll'
    | 'import'
    | 'manual';
  posts: boolean;
  date: string;
  docNum?: string;
  memo?: string;
  reference?: string;
  lines: ParsedSplit[];
}
interface ReferencedAccount {
  name: string;
  suggestedType: AccountType;
  suggestedSubtype: AccountSubtype;
  suggestedCode: string;
  occurrences: number;
}
interface IifPreview {
  accounts: ParsedAccount[];
  customers: ParsedCustomer[];
  vendors: ParsedVendor[];
  transactions: ParsedTransaction[];
  transactionCounts: Record<string, number>;
  nonPostingSkipped: number;
  missingAccounts: ReferencedAccount[];
  unrecognizedSections: string[];
  warnings: string[];
  /** Blocks excluded at parse time for data errors (out of balance,
   * truncated) -- counted in transactionCounts but never posted. */
  excludedTransactions?: { rowNumber: number; qbType: string; reason: string }[];
}
interface CommitResult {
  accountsCreated: number;
  accountsSkipped: number;
  customersCreated: number;
  customersSkipped: number;
  vendorsCreated: number;
  vendorsSkipped: number;
  conflicts: { kind: 'account' | 'customer' | 'vendor'; identifier: string; reason: string }[];
  /** Rows that imported but need attention (renumbered codes, missing 1099 TINs). */
  warnings: string[];
}
interface TransactionCommitResult {
  posted: number;
  skipped: number;
  /** Blocks identical to an already-posted journal entry (re-import of the same file). */
  duplicates: number;
  /** All-zero blocks (voided checks) -- nothing to post. */
  voided: number;
  /** Posted blocks that also wrote a vendor/customer payment record (1099s, statements). */
  paymentsLinked: number;
  /** Duplicate blocks whose earlier run posted GL-only and whose payee
   * matches a vendor/customer NOW -- the missing payment record was written
   * against the already-posted entry (the fix-and-re-import remediation). */
  paymentsBackfilled: number;
  /** Non-fatal disclosures, e.g. a posted block that looks like a
   * transaction edited in QuickBooks after an earlier import. */
  warnings?: string[];
  /** Money-movement blocks that posted GL-only because the payee name matched
   * no vendor/customer -- these amounts are missing from 1099 totals and
   * payroll registers until fixed. */
  unlinkedPayees?: { name: string; count: number; total: string }[];
  errors: { rowNumber: number; qbType: string; reason: string }[];
}

type Stage = 'upload' | 'preview' | 'committed';

export function Imports() {
  const { companyId } = useCurrentCompany();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>('upload');
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<IifPreview | null>(null);
  // The company this preview was parsed against. The commit must post to
  // THIS company and no other: the header's company picker stays usable
  // while a preview is open, and a commit scoped to whichever company is
  // active at Confirm time would import one client's books into another's.
  const [previewCompanyId, setPreviewCompanyId] = useState<string | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<CommitResult | null>(null);
  const [committedTxns, setCommittedTxns] = useState<TransactionCommitResult | null>(null);
  // Per-row include flags so users can opt rows out before commit.
  const [accountInclude, setAccountInclude] = useState<boolean[]>([]);
  // Editable code per !ACCNT row -- the suggestion may clash with the
  // existing chart, so the user must be able to fix it before committing.
  const [accountCodes, setAccountCodes] = useState<string[]>([]);
  const [customerInclude, setCustomerInclude] = useState<boolean[]>([]);
  const [vendorInclude, setVendorInclude] = useState<boolean[]>([]);
  const [includeTransactions, setIncludeTransactions] = useState<boolean>(true);
  // Missing-accounts state: include flag + editable type/subtype/code per row.
  const [missingDraft, setMissingDraft] = useState<
    Array<ReferencedAccount & { include: boolean }>
  >([]);

  const previewMutation = useMutation({
    // companyId travels as a mutation variable so onSuccess can bind the
    // preview to the company it was actually parsed against -- reading the
    // hook value in onSuccess would race a company switch made while the
    // parse request was in flight.
    mutationFn: async (vars: { text: string; companyId: string | null }) =>
      api<IifPreview>('/imports/iif/preview', {
        method: 'POST',
        companyId: vars.companyId,
        body: { text: vars.text },
      }),
    onSuccess: (data, vars) => {
      setPreviewCompanyId(vars.companyId);
      setPreview(data);
      setAccountInclude(data.accounts.map(() => true));
      setAccountCodes(data.accounts.map((a) => a.suggestedCode));
      setCustomerInclude(data.customers.map(() => true));
      setVendorInclude(data.vendors.map(() => true));
      setMissingDraft(
        (data.missingAccounts ?? []).map((m) => ({ ...m, include: true })),
      );
      setStage('preview');
    },
    onError: (err) => {
      setParseError(formatError(err));
    },
  });

  const commitMutation = useMutation({
    mutationFn: async () => {
      if (!preview) throw new Error('no preview');
      // The preview was parsed against previewCompanyId's chart, and the
      // commit must never land anywhere else. The reset-on-company-change
      // effect below normally clears a stale preview before this can run;
      // this guard is the backstop for any render race (cross-tenant
      // import protection -- see assertCommitCompanyUnchanged).
      assertCommitCompanyUnchanged(previewCompanyId, companyId);
      const committedCompanyId = previewCompanyId!;
      const fromIif = preview.accounts
        .map((a, i) => ({ a, i }))
        .filter(({ i }) => accountInclude[i])
        .map(({ a, i }) => ({
          name: a.name,
          type: a.type,
          subtype: a.subtype,
          code: accountCodes[i]?.trim() || a.suggestedCode,
          ...(a.description ? { description: a.description } : {}),
          // HIDDEN=Y in QuickBooks -> inactive here.
          ...(a.isActive === false ? { isActive: false } : {}),
        }));
      const fromMissing = missingDraft
        .map((m, i) => ({ m, i }))
        .filter(({ m }) => m.include)
        .map(({ m, i }) => ({
          name: m.name,
          type: m.suggestedType,
          subtype: m.suggestedSubtype,
          // Same blank-code fallback as the !ACCNT rows above: an emptied
          // input reverts to the original suggestion. An empty code would
          // 400 the entire commit with a concatenated-array index the user
          // can't map back to either visible table.
          code: m.suggestedCode.trim() || (preview.missingAccounts[i]?.suggestedCode ?? m.name),
        }));
      const accounts = [...fromIif, ...fromMissing];
      const customers = preview.customers
        .filter((_, i) => customerInclude[i])
        .map((c) => stripUndef(c));
      const vendors = preview.vendors
        .filter((_, i) => vendorInclude[i])
        .map((v) => stripUndef(v));
      // Step 1: lists (accounts/customers/vendors). Has to land before
      // transactions so the by-name account lookup resolves. Chunked like
      // the transactions leg below: the server awaits one INSERT per row,
      // so a 12-year company file's lists (thousands of customers/vendors)
      // in ONE request would blow the same 60s Cloud Run / Firebase rewrite
      // caps and roll the whole commit back on every retry. Skip-on-name-
      // conflict makes a mid-sequence failure resumable: clicking Confirm
      // again skips the chunks that already landed.
      const listResults: CommitResult[] = [];
      for (const chunk of chunkListsForCommit({ accounts, customers, vendors })) {
        listResults.push(
          await api<CommitResult>('/imports/iif/commit', {
            method: 'POST',
            companyId: committedCompanyId,
            body: chunk,
          }),
        );
      }
      const listsResult: CommitResult = mergeListsCommitResults(listResults);

      // Step 2: transactions. Optional via the includeTransactions toggle.
      let txResult: TransactionCommitResult = {
        posted: 0,
        skipped: 0,
        duplicates: 0,
        voided: 0,
        paymentsLinked: 0,
        paymentsBackfilled: 0,
        warnings: [],
        unlinkedPayees: [],
        errors: [],
      };
      if (includeTransactions && preview.transactions.length > 0) {
        // One request per chunk: Cloud Run and the Firebase Hosting rewrite
        // cap any single request at 60s, and the server posts blocks one at
        // a time -- a multi-year export in one POST times out with a bare
        // "API 504" after silently posting an unknown fraction. Bounded
        // chunks keep every request fast, and the server's duplicate scan
        // makes a mid-sequence failure resumable: clicking Confirm again
        // skips the chunks that already landed.
        const chunkResults: TransactionCommitResult[] = [];
        for (const chunk of chunkTransactionsForCommit(preview.transactions)) {
          chunkResults.push(
            await api<TransactionCommitResult>('/imports/iif/commit-transactions', {
              method: 'POST',
              companyId: committedCompanyId,
              body: { transactions: chunk },
            }),
          );
        }
        txResult = { ...txResult, ...mergeTransactionCommitResults(chunkResults) };
      }

      return { listsResult, txResult, committedCompanyId };
    },
    onSuccess: ({ listsResult, txResult, committedCompanyId }) => {
      // A company switch mid-commit already reset the flow (the import
      // itself still landed in the company it was previewed under); don't
      // resurrect a completion screen for another company's import.
      if (committedCompanyId !== companyId) return;
      setCommitted(listsResult);
      setCommittedTxns(txResult);
      setStage('committed');
      // Refresh downstream lists + ledger views.
      void queryClient.invalidateQueries({ queryKey: ['accounts', committedCompanyId] });
      void queryClient.invalidateQueries({ queryKey: ['customers', committedCompanyId] });
      void queryClient.invalidateQueries({ queryKey: ['vendors', committedCompanyId] });
      void queryClient.invalidateQueries({ queryKey: ['trial-balance', committedCompanyId] });
      void queryClient.invalidateQueries({ queryKey: ['pnl', committedCompanyId] });
      void queryClient.invalidateQueries({ queryKey: ['balance-sheet', committedCompanyId] });
    },
  });

  function reset() {
    setStage('upload');
    setFileName(null);
    setPreview(null);
    setPreviewCompanyId(null);
    setParseError(null);
    setCommitted(null);
    setCommittedTxns(null);
    setAccountInclude([]);
    setAccountCodes([]);
    setCustomerInclude([]);
    setVendorInclude([]);
    setMissingDraft([]);
    setIncludeTransactions(true);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  // Switching companies invalidates the in-flight flow entirely: the
  // preview was parsed against the previous company's chart, and AppShell
  // renders <Imports /> unkeyed, so nothing else clears a still-open
  // preview when the header dropdown changes. Without this reset, Confirm
  // would post the previewed file into whichever company is now active --
  // a cross-tenant import into the wrong client's books.
  useEffect(() => {
    if (previewCompanyId !== null && companyId !== previewCompanyId) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset is stable in behaviour; re-running on its identity would loop
  }, [companyId, previewCompanyId]);

  const SUBTYPES_BY_TYPE: Record<AccountType, AccountSubtype[]> = {
    asset: ['bank', 'accounts_receivable', 'other_current_asset', 'fixed_asset', 'other_asset'],
    liability: ['accounts_payable', 'credit_card', 'other_current_liability', 'long_term_liability'],
    equity: ['equity', 'retained_earnings'],
    revenue: ['income', 'other_income'],
    expense: ['expense', 'cost_of_goods_sold', 'other_expense'],
  };

  function updateMissing(idx: number, patch: Partial<ReferencedAccount & { include: boolean }>) {
    setMissingDraft((prev) =>
      prev.map((m, i) => {
        if (i !== idx) return m;
        const next = { ...m, ...patch };
        // If type changed, snap subtype to the first valid one for that type.
        if (patch.suggestedType && patch.suggestedType !== m.suggestedType) {
          const opts = SUBTYPES_BY_TYPE[patch.suggestedType];
          if (opts && opts.length > 0) next.suggestedSubtype = opts[0]!;
        }
        return next;
      }),
    );
  }

  async function handleFile(file: File) {
    setFileName(file.name);
    setParseError(null);
    // QuickBooks Desktop exports are typically Windows-1252, not UTF-8, and
    // Excel "Unicode Text" re-saves are UTF-16 -- decodeIifBuffer sniffs
    // BOMs and falls back appropriately so neither silently scrambles the
    // parse (see lib/decode-iif.ts).
    const buffer = await file.arrayBuffer();
    const decoded = decodeIifBuffer(buffer);
    if ('error' in decoded) {
      setParseError(decoded.error);
      return;
    }
    const text = decoded.text;
    if (!text.trim()) {
      setParseError('File is empty.');
      return;
    }
    if (text.length > 12_000_000) {
      setParseError(
        `File is ${(text.length / 1e6).toFixed(1)} MB. The import accepts up to 12 MB — export ` +
          'from QuickBooks in date-range chunks (File > Utilities > Export) and import each one. ' +
          'Re-importing overlapping ranges is safe for unchanged transactions: already-posted ' +
          'transactions are skipped as duplicates. (A transaction edited in QuickBooks since an ' +
          'earlier import posts again — the import warns when it detects that.)',
      );
      return;
    }
    previewMutation.mutate({ text, companyId });
  }

  // Blocks excluded at parse time for data errors. They never reach the
  // commit, so both the preview table and the completion screen must
  // disclose them from the preview payload.
  const excludedTxns = preview?.excludedTransactions ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">Import from QuickBooks</h2>
        <p className="text-sm text-slate-500">
          Upload an .iif export to bring over your chart of accounts, customers, vendors, and
          historical transactions. Transactions post to the ledger as journal entries by default —
          do NOT also post an opening journal entry, or every balance will be double-counted. To
          bring over lists only, untick “Import transactions” in the preview and post an opening
          journal entry instead.
        </p>
      </div>

      {stage === 'upload' && (
        <div
          onDragOver={(e) => {
            // preventDefault is required: without it the browser's default
            // action for a dropped file is to navigate away to the file.
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer?.files?.[0];
            if (file) void handleFile(file);
          }}
          className={
            'rounded-md border-2 border-dashed bg-white p-8 transition-colors ' +
            (dragOver ? 'border-emerald-400 bg-emerald-50/40' : 'border-slate-300')
          }
        >
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
              {preview.vendors.length} vendors · {preview.transactions.length} postable transactions
              {preview.nonPostingSkipped > 0 && (
                <> · {preview.nonPostingSkipped} non-posting (estimates / orders)</>
              )}
              {excludedTxns.length > 0 && (
                <>
                  {' '}
                  ·{' '}
                  <span className="font-medium text-rose-700">
                    {excludedTxns.length} excluded (data errors — see warnings)
                  </span>
                </>
              )}
              {missingDraft.length > 0 && (
                <> · {missingDraft.length} missing accounts to auto-create</>
              )}
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
                      <td className="px-3 py-2">
                        <input
                          type="text"
                          value={accountCodes[i] ?? a.suggestedCode}
                          onChange={(e) =>
                            setAccountCodes((prev) =>
                              prev.map((c, j) => (j === i ? e.target.value : c)),
                            )
                          }
                          maxLength={40}
                          className="w-24 rounded-md border border-slate-300 px-2 py-1 font-mono text-xs focus:border-slate-900 focus:outline-none"
                        />
                      </td>
                      <td className="px-3 py-2 text-slate-900">
                        {a.name}
                        {a.isActive === false && (
                          <span className="ml-2 text-xs text-slate-400">inactive in QuickBooks</span>
                        )}
                      </td>
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
                        <div className="font-medium">
                          {c.displayName}
                          {c.isActive === false && (
                            <span className="ml-2 text-xs font-normal text-slate-400">
                              inactive in QuickBooks
                            </span>
                          )}
                        </div>
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
                        <div className="font-medium">
                          {v.displayName}
                          {v.isActive === false && (
                            <span className="ml-2 text-xs font-normal text-slate-400">
                              inactive in QuickBooks
                            </span>
                          )}
                        </div>
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

          {missingDraft.length > 0 && (
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-slate-700">
                  Missing accounts referenced by transactions{' '}
                  <span className="text-slate-500">({missingDraft.length})</span>
                </h3>
                <button
                  type="button"
                  onClick={() =>
                    setMissingDraft((prev) => {
                      const allOn = prev.every((m) => m.include);
                      return prev.map((m) => ({ ...m, include: !allOn }));
                    })
                  }
                  className="text-xs text-slate-600 underline hover:text-slate-900"
                >
                  {missingDraft.every((m) => m.include) ? 'Deselect all' : 'Select all'}
                </button>
              </div>
              <p className="text-xs text-slate-500">
                These account names appear in the file's transactions but aren't in your chart of
                accounts and aren't being created from this file's account section. We've guessed a
                type/subtype from each name — review and edit, then confirm. Auto-created accounts
                are committed before transactions post, so the JEs land cleanly.
              </p>
              <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="w-10 px-3 py-2"></th>
                      <th className="px-3 py-2 text-left font-medium">Code</th>
                      <th className="px-3 py-2 text-left font-medium">Name</th>
                      <th className="px-3 py-2 text-left font-medium">Type</th>
                      <th className="px-3 py-2 text-left font-medium">Subtype</th>
                      <th className="px-3 py-2 text-right font-medium">Used in</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {missingDraft.map((m, i) => (
                      <tr key={m.name} className={m.include ? '' : 'opacity-40'}>
                        <td className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={m.include}
                            onChange={(e) => updateMissing(i, { include: e.target.checked })}
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            value={m.suggestedCode}
                            onChange={(e) => updateMissing(i, { suggestedCode: e.target.value })}
                            maxLength={40}
                            className="w-24 rounded-md border border-slate-300 px-2 py-1 font-mono text-xs focus:border-slate-900 focus:outline-none"
                          />
                        </td>
                        <td className="px-3 py-2 text-slate-900">{m.name}</td>
                        <td className="px-3 py-2">
                          <select
                            value={m.suggestedType}
                            onChange={(e) =>
                              updateMissing(i, { suggestedType: e.target.value as AccountType })
                            }
                            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs focus:border-slate-900 focus:outline-none"
                          >
                            <option value="asset">asset</option>
                            <option value="liability">liability</option>
                            <option value="equity">equity</option>
                            <option value="revenue">revenue</option>
                            <option value="expense">expense</option>
                          </select>
                        </td>
                        <td className="px-3 py-2">
                          <select
                            value={m.suggestedSubtype}
                            onChange={(e) =>
                              updateMissing(i, {
                                suggestedSubtype: e.target.value as AccountSubtype,
                              })
                            }
                            className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs focus:border-slate-900 focus:outline-none"
                          >
                            {SUBTYPES_BY_TYPE[m.suggestedType].map((s) => (
                              <option key={s} value={s}>
                                {s.replace(/_/g, ' ')}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-right text-slate-600">
                          {m.occurrences} txn{m.occurrences === 1 ? '' : 's'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {(preview.transactions.length > 0 || excludedTxns.length > 0) && (
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-slate-700">
                  Transactions{' '}
                  <span className="text-slate-500">({preview.transactions.length} postable)</span>
                </h3>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={includeTransactions}
                    onChange={(e) => setIncludeTransactions(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Import transactions
                </label>
              </div>

              <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">QB type</th>
                      <th className="px-4 py-2 text-left font-medium">Maps to</th>
                      <th className="px-4 py-2 text-right font-medium">Count</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {Object.entries(preview.transactionCounts)
                      .sort(([a], [b]) => a.localeCompare(b))
                      .map(([qbType, count]) => {
                        // The first txn of this type tells us how it'll map.
                        // Types with no surviving sample were either
                        // non-posting OR excluded for data errors -- the two
                        // must not read the same (an excluded CHECK is not an
                        // intentionally skipped document class).
                        const sample = preview.transactions.find((t) => t.qbType === qbType);
                        const excludedOfType = excludedTxns.filter(
                          (e) => e.qbType === qbType,
                        ).length;
                        const mapsTo = mapsToLabel(sample, excludedOfType);
                        const suffix =
                          sample && excludedOfType > 0
                            ? ` — ${excludedOfType} of ${count} excluded (data error; see warnings)`
                            : '';
                        return (
                          <tr key={qbType}>
                            <td className="px-4 py-2 font-mono text-slate-900">{qbType}</td>
                            <td className="px-4 py-2 text-slate-700">
                              {mapsTo}
                              {suffix}
                            </td>
                            <td className="px-4 py-2 text-right font-mono text-slate-900">{count}</td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>

              <p className="text-xs text-slate-500">
                Each posting transaction becomes one journal_entry. Sign rule: positive amount = debit,
                negative = credit. Transactions whose accounts aren't in the chart of accounts after the
                lists step are skipped and reported.
              </p>
            </section>
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
              {committedTxns && (
                <li>
                  {committedTxns.posted} transactions posted
                  {committedTxns.paymentsLinked > 0
                    ? `, ${committedTxns.paymentsLinked} linked to vendor/customer payment records (1099s, statements)`
                    : ''}
                  {committedTxns.skipped > 0 ? `, ${committedTxns.skipped} skipped` : ''}
                  {committedTxns.duplicates > 0
                    ? `, ${committedTxns.duplicates} already imported (duplicates skipped)`
                    : ''}
                  {committedTxns.paymentsBackfilled > 0
                    ? `, ${committedTxns.paymentsBackfilled} payment record(s) backfilled for previously imported transactions`
                    : ''}
                  {committedTxns.voided > 0
                    ? `, ${committedTxns.voided} voided (0.00 — nothing to post)`
                    : ''}
                </li>
              )}
            </ul>
          </div>

          {committed.warnings.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium">{committed.warnings.length} import note(s):</p>
              <ul className="mt-1 max-h-60 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {committed.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {committed.conflicts.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium">{committed.conflicts.length} list rows skipped:</p>
              <ul className="mt-1 max-h-60 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {committed.conflicts.map((c, i) => (
                  <li key={i}>
                    <span className="font-medium">{c.kind}</span>: {c.identifier} — {c.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {committedTxns && committedTxns.errors.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium">
                {committedTxns.errors.length} transaction(s) skipped:
              </p>
              <ul className="mt-1 max-h-60 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {committedTxns.errors.slice(0, 200).map((e, i) => (
                  <li key={i}>
                    <span className="font-mono">{e.qbType}</span> at row {e.rowNumber} — {e.reason}
                  </li>
                ))}
                {committedTxns.errors.length > 200 && (
                  <li>… and {committedTxns.errors.length - 200} more</li>
                )}
              </ul>
            </div>
          )}

          {committedTxns && (committedTxns.warnings ?? []).length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium">
                {(committedTxns.warnings ?? []).length} transaction note(s):
              </p>
              <ul className="mt-1 max-h-60 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {(committedTxns.warnings ?? []).slice(0, 200).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
                {(committedTxns.warnings ?? []).length > 200 && (
                  <li>… and {(committedTxns.warnings ?? []).length - 200} more</li>
                )}
              </ul>
            </div>
          )}

          {/* Blocks dropped at parse time never reach the commit, so the
              posted/skipped counts above can't account for them. Without this
              box the completion screen would show "0 skipped, 0 errors" while
              the bank register is silently short. */}
          {includeTransactions && excludedTxns.length > 0 && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              <p className="font-medium">
                {excludedTxns.length} transaction block(s) from the file were NOT imported (data
                errors found before posting):
              </p>
              <ul className="mt-1 max-h-60 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {excludedTxns.slice(0, 200).map((e, i) => (
                  <li key={i}>
                    <span className="font-mono">{e.qbType}</span> at row {e.rowNumber} — {e.reason}
                  </li>
                ))}
                {excludedTxns.length > 200 && <li>… and {excludedTxns.length - 200} more</li>}
              </ul>
              <p className="mt-1 text-xs">
                Fix these rows in the file and re-import it — already-posted transactions are
                skipped as duplicates (as long as they weren't edited in QuickBooks since the
                last import; an edited transaction posts again as a new entry).
              </p>
            </div>
          )}

          {committedTxns && (committedTxns.unlinkedPayees ?? []).length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium">
                {(committedTxns.unlinkedPayees ?? []).length} payee(s) posted to the ledger only —
                no vendor/customer payment record was written:
              </p>
              <ul className="mt-1 max-h-60 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {(committedTxns.unlinkedPayees ?? []).slice(0, 200).map((p, i) => (
                  <li key={i}>
                    <span className="font-medium">{p.name}</span> — {p.count} transaction
                    {p.count === 1 ? '' : 's'} totaling {p.total}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs">
                These names didn't match any vendor or customer (check spelling/punctuation, QuickBooks
                “Other Names”, or employees). Their amounts won't appear in 1099 totals, payroll
                registers, or statements until matching payment records exist. To fix: create the
                missing vendor/customer (or correct its spelling) and re-import this file — the
                transactions are skipped as duplicates and their payment records are backfilled
                automatically.
              </p>
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
    const body = err.body as {
      error?: string;
      message?: string;
      details?: { path?: (string | number)[]; message?: string }[];
    } | null;
    if (body?.message) return `${body.error ?? 'Error'}: ${body.message}`;
    if (body?.error) {
      // Zod issues carry the offending row in `path` (e.g. customers.1.email).
      // Surface the first few so the user can find the bad row instead of
      // staring at a bare "validation_failed".
      if (Array.isArray(body.details) && body.details.length > 0) {
        const shown = body.details
          .slice(0, 3)
          .map((d) => `${(d.path ?? []).join('.') || 'request'}: ${d.message ?? 'invalid'}`)
          .join('; ');
        const more = body.details.length > 3 ? ` (+${body.details.length - 3} more)` : '';
        return `${body.error} — ${shown}${more}`;
      }
      return body.error;
    }
  }
  return err instanceof Error ? err.message : 'Operation failed.';
}
