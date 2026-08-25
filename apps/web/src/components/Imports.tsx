import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, api } from '../lib/api';
import { useCurrentCompany } from '../lib/current-company';
import { checkIifFileMeta, decodeIifBuffer } from '../lib/decode-iif';
import {
  type PartialCommitProgress,
  assertCommitCompanyUnchanged,
  runChunkedCommit,
} from '../lib/iif-commit';
import { mapsToLabel, orderWarningsForDisplay } from '../lib/iif-preview';

type Translate = TFunction<readonly ['banking', 'common']>;

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
  const { t } = useTranslation(['banking', 'common']);
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
  // What actually landed when the chunked commit fails partway. The commit
  // is a sequence of independent requests, each its own server-side DB
  // transaction, so "the import failed" is almost never the whole truth --
  // this is what the error panel needs to say how much is already on the
  // ledger and that clicking Confirm again resumes instead of double-booking.
  const [partialCommit, setPartialCommit] = useState<PartialCommitProgress | null>(null);
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
    mutationFn: async (vars: {
      companyId: string | null;
      endpoint: string;
      body: Record<string, unknown>;
    }) =>
      api<IifPreview>(vars.endpoint, {
        method: 'POST',
        companyId: vars.companyId,
        body: vars.body,
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
      setParseError(formatError(err, t));
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
      // Both legs go out one chunk per request (see runChunkedCommit): lists
      // first, so the transactions leg's by-name account lookup resolves.
      // Cloud Run and the Firebase Hosting rewrite cap any single request at
      // 60s while the server writes rows one at a time, so a 12-year company
      // file sent whole times out with a bare "API 504" and rolls back on
      // every retry. Each chunk commits independently, which also means a
      // mid-sequence failure leaves earlier chunks on the ledger -- onPartial
      // captures exactly that so the UI can say so instead of looking
      // untouched.
      const { listsResult, txResult } = await runChunkedCommit({
        lists: { accounts, customers, vendors },
        transactions:
          includeTransactions && preview.transactions.length > 0 ? preview.transactions : [],
        sendLists: (chunk) =>
          api<CommitResult>('/imports/iif/commit', {
            method: 'POST',
            companyId: committedCompanyId,
            body: chunk,
          }),
        sendTransactions: (chunk) =>
          api<TransactionCommitResult>('/imports/iif/commit-transactions', {
            method: 'POST',
            companyId: committedCompanyId,
            body: { transactions: chunk },
          }),
        onPartial: setPartialCommit,
      });

      return { listsResult, txResult, committedCompanyId };
    },
    // A retry after a partial failure starts from a clean slate: the panel
    // below must describe THIS attempt, not the previous one.
    onMutate: () => setPartialCommit(null),
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
    setPartialCommit(null);
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

  /** Base64 in chunks: apply() over a whole multi-MB file overflows the stack. */
  function toBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  async function handleFile(file: File) {
    setFileName(file.name);
    setParseError(null);

    // QuickBooks cannot export transactions to IIF, so full history arrives
    // as a Journal report instead: .xlsx from "Export to Excel", or .csv if
    // the user picked that. Those take a different endpoint; .iif keeps the
    // original path with its encoding sniffing and size checks.
    const lower = file.name.toLowerCase();
    const isJournal =
      lower.endsWith('.xlsx') || lower.endsWith('.xls') || lower.endsWith('.csv');
    if (isJournal) {
      let buf: ArrayBuffer;
      try {
        buf = await file.arrayBuffer();
      } catch (err) {
        setParseError(
          t('imports.readFailed', {
            name: file.name,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }
      if (buf.byteLength === 0) {
        setParseError(t('imports.fileEmpty'));
        return;
      }
      if (lower.endsWith('.csv')) {
        const decoded = decodeIifBuffer(buf);
        if ('error' in decoded) {
          setParseError(decoded.error);
          return;
        }
        previewMutation.mutate({
          companyId,
          endpoint: '/imports/journal/preview',
          body: { text: decoded.text },
        });
      } else {
        previewMutation.mutate({
          companyId,
          endpoint: '/imports/journal/preview',
          body: { fileBase64: toBase64(buf) },
        });
      }
      return;
    }
    // Name/size are judged BEFORE the read: the post-decode checks below only
    // fire once the whole file has been materialised as an ArrayBuffer and
    // decoded again as text, so a company-file backup dragged in by mistake
    // froze the tab for seconds and then reported the wrong problem entirely
    // (see checkIifFileMeta).
    const problem = checkIifFileMeta(file);
    if (problem) {
      setParseError(
        problem.kind === 'notAnIifFile'
          ? t('imports.notAnIifFile', { name: file.name })
          : problem.kind === 'emptyOrFolder'
            ? t('imports.emptyOrFolder')
            : t('imports.fileTooLarge', { size: problem.sizeMb }),
      );
      return;
    }
    // QuickBooks Desktop exports are typically Windows-1252, not UTF-8, and
    // Excel "Unicode Text" re-saves are UTF-16 -- decodeIifBuffer sniffs
    // BOMs and falls back appropriately so neither silently scrambles the
    // parse (see lib/decode-iif.ts).
    // file.arrayBuffer() rejects on its own (a file moved or re-exported
    // since it was picked, a disconnected network share, an on-demand
    // OneDrive placeholder). Both call sites fire this as `void handleFile`,
    // so an uncaught rejection would leave the filename on screen with no
    // error, no spinner and no state change -- indistinguishable from the
    // click doing nothing.
    let buffer: ArrayBuffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (err) {
      setParseError(
        t('imports.readFailed', {
          name: file.name,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }
    const decoded = decodeIifBuffer(buffer);
    if ('error' in decoded) {
      setParseError(decoded.error);
      return;
    }
    const text = decoded.text;
    if (!text.trim()) {
      setParseError(t('imports.fileEmpty'));
      return;
    }
    if (text.length > 12_000_000) {
      setParseError(t('imports.fileTooLarge', { size: (text.length / 1e6).toFixed(1) }));
      return;
    }
    previewMutation.mutate({ companyId, endpoint: '/imports/iif/preview', body: { text } });
  }

  // Blocks excluded at parse time for data errors. They never reach the
  // commit, so both the preview table and the completion screen must
  // disclose them from the preview payload.
  const excludedTxns = preview?.excludedTransactions ?? [];

  // File-level disclosures (inactive accounts, opening balances, unrecognized
  // rows) are appended AFTER the per-row warnings, so rendering the raw first
  // 100 dropped exactly the notes the user must act on before committing.
  const { shown: shownWarnings, hidden: hiddenWarnings } = orderWarningsForDisplay(
    preview?.warnings ?? [],
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold tracking-tight text-slate-900">
          {t('imports.title')}
        </h2>
        <p className="text-sm text-slate-500">{t('imports.subtitle')}</p>
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
            accept=".iif,.csv,.xlsx,.xls,text/plain"
            className="hidden"
            // Clear before the picker opens, or re-selecting the SAME path
            // fires no change event and nothing happens: every failure path
            // here (encoding, empty, too large, preview error) tells the user
            // to fix the file and try again, and the fix is almost always a
            // re-save over the same path. Only reset() cleared this before,
            // and it isn't reachable from the upload stage.
            onClick={(e) => {
              e.currentTarget.value = '';
            }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
          />
          <div className="flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-slate-600">{t('imports.dropHint')}</p>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={previewMutation.isPending}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {previewMutation.isPending ? t('imports.parsing') : t('imports.chooseFile')}
            </button>
            {fileName && <p className="text-xs text-slate-500">{fileName}</p>}
            {parseError && <p className="text-sm text-rose-600">{parseError}</p>}
          </div>
        </div>
      )}

      {stage === 'preview' && preview && (
        <div className="space-y-6">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm">
            <p className="font-medium text-slate-900">
              {t('imports.previewFrom', { fileName })}
            </p>
            <p className="text-slate-600">
              {t('imports.counts', {
                accounts: preview.accounts.length,
                customers: preview.customers.length,
                vendors: preview.vendors.length,
                transactions: preview.transactions.length,
              })}
              {preview.nonPostingSkipped > 0 && (
                <>{t('imports.nonPosting', { n: preview.nonPostingSkipped })}</>
              )}
              {excludedTxns.length > 0 && (
                <>
                  {' '}
                  ·{' '}
                  <span className="font-medium text-rose-700">
                    {t('imports.excludedCount', { n: excludedTxns.length })}
                  </span>
                </>
              )}
              {missingDraft.length > 0 && (
                <>{t('imports.missingToCreate', { n: missingDraft.length })}</>
              )}
            </p>
            {preview.unrecognizedSections.length > 0 && (
              <p className="mt-1 text-xs text-amber-700">
                {t('imports.unrecognized', {
                  sections: preview.unrecognizedSections.join(', '),
                })}
              </p>
            )}
            {preview.warnings.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-slate-700">
                  {t('imports.parserWarnings', { count: preview.warnings.length })}
                </summary>
                <ul className="mt-1 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-slate-600">
                  {shownWarnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                  {hiddenWarnings > 0 && <li>{t('imports.andMore', { n: hiddenWarnings })}</li>}
                </ul>
              </details>
            )}
          </div>

          {preview.accounts.length > 0 && (
            <PreviewSection
              title={t('imports.sections.accounts')}
              count={preview.accounts.length}
              includeStates={accountInclude}
              setIncludeStates={setAccountInclude}
            >
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="w-10 px-3 py-2"></th>
                    <th className="px-3 py-2 text-left font-medium">{t('imports.columns.code')}</th>
                    <th className="px-3 py-2 text-left font-medium">{t('common:name')}</th>
                    <th className="px-3 py-2 text-left font-medium">{t('imports.columns.type')}</th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t('imports.columns.qbType')}
                    </th>
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
                          <span className="ml-2 text-xs text-slate-400">
                            {t('imports.inactiveInQuickBooks')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-700">
                        {t(`accountType.${a.type}`, { defaultValue: a.type })} ·{' '}
                        {t(`accountSubtype.${a.subtype}`, {
                          defaultValue: a.subtype.replace(/_/g, ' '),
                        })}
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
              title={t('imports.sections.customers')}
              count={preview.customers.length}
              includeStates={customerInclude}
              setIncludeStates={setCustomerInclude}
            >
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="w-10 px-3 py-2"></th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t('imports.columns.displayName')}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t('imports.columns.email')}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t('imports.columns.phone')}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t('imports.columns.terms')}
                    </th>
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
                              {t('imports.inactiveInQuickBooks')}
                            </span>
                          )}
                        </div>
                        {c.companyName && <div className="text-xs text-slate-500">{c.companyName}</div>}
                      </td>
                      <td className="px-3 py-2 text-slate-700">{c.email ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-700">{c.phone ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-slate-700">
                        {c.defaultTermsDays === undefined
                          ? '—'
                          : t('imports.netTerms', { days: c.defaultTermsDays })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </PreviewSection>
          )}

          {preview.vendors.length > 0 && (
            <PreviewSection
              title={t('imports.sections.vendors')}
              count={preview.vendors.length}
              includeStates={vendorInclude}
              setIncludeStates={setVendorInclude}
            >
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="w-10 px-3 py-2"></th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t('imports.columns.displayName')}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t('imports.columns.email')}
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      {t('imports.columns.phone')}
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      {t('imports.columns.terms')}
                    </th>
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
                              {t('imports.inactiveInQuickBooks')}
                            </span>
                          )}
                        </div>
                        {v.companyName && <div className="text-xs text-slate-500">{v.companyName}</div>}
                      </td>
                      <td className="px-3 py-2 text-slate-700">{v.email ?? '—'}</td>
                      <td className="px-3 py-2 text-slate-700">{v.phone ?? '—'}</td>
                      <td className="px-3 py-2 text-right text-slate-700">
                        {v.defaultTermsDays === undefined
                          ? '—'
                          : t('imports.netTerms', { days: v.defaultTermsDays })}
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
                  {t('imports.missing.title')}{' '}
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
                  {missingDraft.every((m) => m.include)
                    ? t('imports.deselectAll')
                    : t('imports.selectAll')}
                </button>
              </div>
              <p className="text-xs text-slate-500">{t('imports.missing.hint')}</p>
              <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="w-10 px-3 py-2"></th>
                      <th className="px-3 py-2 text-left font-medium">{t('imports.columns.code')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('common:name')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('imports.columns.type')}</th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t('imports.columns.subtype')}
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        {t('imports.columns.usedIn')}
                      </th>
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
                            <option value="asset">{t('accountType.asset')}</option>
                            <option value="liability">{t('accountType.liability')}</option>
                            <option value="equity">{t('accountType.equity')}</option>
                            <option value="revenue">{t('accountType.revenue')}</option>
                            <option value="expense">{t('accountType.expense')}</option>
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
                                {t(`accountSubtype.${s}`, { defaultValue: s.replace(/_/g, ' ') })}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-3 py-2 text-right text-slate-600">
                          {t('imports.missing.occurrences', { count: m.occurrences })}
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
                  {t('imports.transactions.title')}{' '}
                  <span className="text-slate-500">
                    {t('imports.transactions.postableCount', {
                      n: preview.transactions.length,
                    })}
                  </span>
                </h3>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={includeTransactions}
                    onChange={(e) => setIncludeTransactions(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  {t('imports.transactions.include')}
                </label>
              </div>

              <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">
                        {t('imports.columns.qbType')}
                      </th>
                      <th className="px-4 py-2 text-left font-medium">
                        {t('imports.columns.mapsTo')}
                      </th>
                      <th className="px-4 py-2 text-right font-medium">
                        {t('imports.columns.count')}
                      </th>
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
                        const sample = preview.transactions.find((tx) => tx.qbType === qbType);
                        const excludedOfType = excludedTxns.filter(
                          (e) => e.qbType === qbType,
                        ).length;
                        const mapsTo = mapsToLabel(sample, excludedOfType);
                        const suffix =
                          sample && excludedOfType > 0
                            ? t('imports.transactions.excludedSuffix', {
                                excluded: excludedOfType,
                                total: count,
                              })
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

              <p className="text-xs text-slate-500">{t('imports.transactions.hint')}</p>
            </section>
          )}

          <div className="flex items-center gap-3 border-t border-slate-200 pt-4">
            <button
              type="button"
              onClick={() => commitMutation.mutate()}
              disabled={commitMutation.isPending}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {commitMutation.isPending ? t('imports.importing') : t('imports.confirmImport')}
            </button>
            <button
              type="button"
              onClick={reset}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
            >
              {t('common:cancel')}
            </button>
          </div>

          {commitMutation.isError && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {formatError(commitMutation.error, t)}
            </div>
          )}

          {/* A failed commit is not an untouched ledger: the chunks that ran
              before the failure are already committed server-side. Say what
              landed and how to resume, or the CPA re-exports from QuickBooks
              (or gives up) with half the file already in the books. */}
          {partialCommit && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium">{t('imports.partial.title')}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                <li>
                  {t('imports.partial.lists', {
                    done: partialCommit.listChunksDone,
                    total: partialCommit.listChunksTotal,
                    accounts: partialCommit.lists.accountsCreated,
                    customers: partialCommit.lists.customersCreated,
                    vendors: partialCommit.lists.vendorsCreated,
                  })}
                </li>
                {partialCommit.txnChunksTotal > 0 && (
                  <li>
                    {t('imports.partial.transactions', {
                      done: partialCommit.txnChunksDone,
                      total: partialCommit.txnChunksTotal,
                      posted: partialCommit.txns.posted,
                      duplicates: partialCommit.txns.duplicates,
                    })}
                  </li>
                )}
              </ul>
              <p className="mt-1 text-xs">{t('imports.partial.hint')}</p>
            </div>
          )}
        </div>
      )}

      {stage === 'committed' && committed && (
        <div className="space-y-4">
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            <p className="font-medium">{t('imports.done.title')}</p>
            <ul className="mt-1 list-disc pl-5">
              <li>
                {t('imports.done.accountsCreated', { n: committed.accountsCreated })}
                {committed.accountsSkipped > 0
                  ? t('imports.done.skippedSuffix', { n: committed.accountsSkipped })
                  : ''}
              </li>
              <li>
                {t('imports.done.customersCreated', { n: committed.customersCreated })}
                {committed.customersSkipped > 0
                  ? t('imports.done.skippedSuffix', { n: committed.customersSkipped })
                  : ''}
              </li>
              <li>
                {t('imports.done.vendorsCreated', { n: committed.vendorsCreated })}
                {committed.vendorsSkipped > 0
                  ? t('imports.done.skippedSuffix', { n: committed.vendorsSkipped })
                  : ''}
              </li>
              {committedTxns && (
                <li>
                  {t('imports.done.transactionsPosted', { n: committedTxns.posted })}
                  {committedTxns.paymentsLinked > 0
                    ? t('imports.done.paymentsLinked', { n: committedTxns.paymentsLinked })
                    : ''}
                  {committedTxns.skipped > 0
                    ? t('imports.done.skippedSuffix', { n: committedTxns.skipped })
                    : ''}
                  {committedTxns.duplicates > 0
                    ? t('imports.done.duplicatesSkipped', { n: committedTxns.duplicates })
                    : ''}
                  {committedTxns.paymentsBackfilled > 0
                    ? t('imports.done.paymentsBackfilled', {
                        n: committedTxns.paymentsBackfilled,
                      })
                    : ''}
                  {committedTxns.voided > 0
                    ? t('imports.done.voided', { n: committedTxns.voided })
                    : ''}
                </li>
              )}
            </ul>
          </div>

          {committed.warnings.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium">
                {t('imports.notes.importNotes', { count: committed.warnings.length })}
              </p>
              <ul className="mt-1 max-h-60 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {committed.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {committed.conflicts.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium">
                {t('imports.notes.listRowsSkipped', { count: committed.conflicts.length })}
              </p>
              <ul className="mt-1 max-h-60 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {committed.conflicts.map((c, i) => (
                  <li key={i}>
                    <span className="font-medium">{t(`imports.conflictKind.${c.kind}`)}</span>:{' '}
                    {c.identifier} — {c.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {committedTxns && committedTxns.errors.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium">
                {t('imports.notes.transactionsSkipped', { count: committedTxns.errors.length })}
              </p>
              <ul className="mt-1 max-h-60 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {committedTxns.errors.slice(0, 200).map((e, i) => (
                  <li key={i}>
                    <span className="font-mono">{e.qbType}</span>{' '}
                    {t('imports.atRow', { row: e.rowNumber })} — {e.reason}
                  </li>
                ))}
                {committedTxns.errors.length > 200 && (
                  <li>{t('imports.andMore', { n: committedTxns.errors.length - 200 })}</li>
                )}
              </ul>
            </div>
          )}

          {committedTxns && (committedTxns.warnings ?? []).length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium">
                {t('imports.notes.transactionNotes', {
                  count: (committedTxns.warnings ?? []).length,
                })}
              </p>
              <ul className="mt-1 max-h-60 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {(committedTxns.warnings ?? []).slice(0, 200).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
                {(committedTxns.warnings ?? []).length > 200 && (
                  <li>
                    {t('imports.andMore', { n: (committedTxns.warnings ?? []).length - 200 })}
                  </li>
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
                {t('imports.excluded.title', { count: excludedTxns.length })}
              </p>
              <ul className="mt-1 max-h-60 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {excludedTxns.slice(0, 200).map((e, i) => (
                  <li key={i}>
                    <span className="font-mono">{e.qbType}</span>{' '}
                    {t('imports.atRow', { row: e.rowNumber })} — {e.reason}
                  </li>
                ))}
                {excludedTxns.length > 200 && (
                  <li>{t('imports.andMore', { n: excludedTxns.length - 200 })}</li>
                )}
              </ul>
              <p className="mt-1 text-xs">{t('imports.excluded.hint')}</p>
            </div>
          )}

          {committedTxns && (committedTxns.unlinkedPayees ?? []).length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <p className="font-medium">
                {t('imports.unlinked.title', {
                  count: (committedTxns.unlinkedPayees ?? []).length,
                })}
              </p>
              <ul className="mt-1 max-h-60 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs">
                {(committedTxns.unlinkedPayees ?? []).slice(0, 200).map((p, i) => (
                  <li key={i}>
                    <span className="font-medium">{p.name}</span> —{' '}
                    {t('imports.unlinked.row', { count: p.count, total: p.total })}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs">{t('imports.unlinked.hint')}</p>
            </div>
          )}

          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-slate-300 px-4 py-2 text-sm hover:bg-slate-100"
          >
            {t('imports.importAnother')}
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
  const { t } = useTranslation(['banking', 'common']);
  const includedCount = includeStates.filter(Boolean).length;
  const allOn = includedCount === count;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">
          {title}{' '}
          <span className="text-slate-500">
            {t('imports.selectedOf', { included: includedCount, total: count })}
          </span>
        </h3>
        <button
          type="button"
          onClick={() => setIncludeStates(Array(count).fill(!allOn))}
          className="text-xs text-slate-600 underline hover:text-slate-900"
        >
          {allOn ? t('imports.deselectAll') : t('imports.selectAll')}
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

function formatError(err: unknown, t: Translate): string {
  if (err instanceof ApiError) {
    const body = err.body as {
      error?: string;
      message?: string;
      details?: { path?: (string | number)[]; message?: string }[];
    } | null;
    if (body?.message) return `${body.error ?? t('errors.label')}: ${body.message}`;
    if (body?.error) {
      // Zod issues carry the offending row in `path` (e.g. customers.1.email).
      // Surface the first few so the user can find the bad row instead of
      // staring at a bare "validation_failed".
      if (Array.isArray(body.details) && body.details.length > 0) {
        const shown = body.details
          .slice(0, 3)
          .map(
            (d) =>
              `${(d.path ?? []).join('.') || t('imports.detailFallbackPath')}: ${
                d.message ?? t('imports.detailFallbackMessage')
              }`,
          )
          .join('; ');
        const more =
          body.details.length > 3
            ? t('imports.andMoreDetails', { n: body.details.length - 3 })
            : '';
        return `${body.error} — ${shown}${more}`;
      }
      return body.error;
    }
  }
  return err instanceof Error ? err.message : t('errors.operationFailed');
}
