/**
 * Client-side chunking + result merging for the lists and transactions
 * commits, extracted from the Imports component so it is unit-testable (see
 * apps/api/test/iif-gauntlet.test.ts).
 *
 * Why chunk at all: Cloud Run's request timeout AND the Firebase Hosting
 * /v1 rewrite cap any single request at 60 seconds, while the server posts
 * IIF blocks strictly sequentially (~6 DB round-trips per block). A
 * multi-year export sent as ONE request blows the deadline, the whole
 * transaction rolls back, and the browser shows a bare "API 504" -- so the
 * client sends bounded chunks instead. The server's fingerprint dedupe
 * makes a mid-sequence failure safely resumable: chunks that already
 * committed skip as duplicates on the next Confirm.
 *
 * Why key-grouping matters: the server's dedupe treats N identical blocks
 * in one request as a multiset (N copies post once each). If identical
 * blocks were split across two requests, the second request's pre-scan
 * would see the first's copies as prior duplicates and silently drop
 * legitimate transactions -- so all blocks sharing a content key always
 * travel in the same chunk.
 */

/** Blocks per commit-transactions request. ~6 sequential DB statements per
 * block server-side keeps a full chunk well under the 60s request caps even
 * on a slow cross-cloud round-trip. */
export const COMMIT_CHUNK_SIZE = 500;

export interface CommitTransactionLike {
  date: string;
  reference?: string | undefined;
  memo?: string | undefined;
  lines: { account: string; amount: string }[];
}

export interface TransactionCommitResultLike {
  posted: number;
  skipped: number;
  duplicates: number;
  voided: number;
  paymentsLinked: number;
  paymentsBackfilled: number;
  unlinkedPayees?: { name: string; count: number; total: string }[];
  warnings?: string[];
  errors: { rowNumber: number; qbType: string; reason: string }[];
}

/**
 * Duplicate-identity key mirroring the server's entryFingerprint: date +
 * reference + memo + the sorted multiset of (account, signed amount) lines,
 * zero lines dropped. Account names are lower-cased because the server
 * resolves them case-insensitively before fingerprinting -- two blocks with
 * the same server fingerprint always share this key.
 */
function contentKey(t: CommitTransactionLike): string {
  const lines = t.lines
    .filter((l) => !/^-?0+\.0{4}$/.test(l.amount))
    .map((l) => `${l.account.toLowerCase()}:${l.amount}`)
    .sort()
    .join('|');
  return `${t.date} ${t.reference ?? ''} ${t.memo ?? ''} ${lines}`;
}

/**
 * Split transactions into commit-sized chunks, guaranteeing that blocks
 * with the same content key land in the same chunk (see module comment). A
 * chunk can therefore exceed chunkSize by the size of a key group; groups
 * are almost always size 1.
 */
export function chunkTransactionsForCommit<T extends CommitTransactionLike>(
  transactions: readonly T[],
  chunkSize = COMMIT_CHUNK_SIZE,
): T[][] {
  const chunks: T[][] = [];
  const homeByKey = new Map<string, T[]>();
  let current: T[] | null = null;
  for (const t of transactions) {
    const key = contentKey(t);
    const home = homeByKey.get(key);
    if (home) {
      home.push(t);
      continue;
    }
    if (!current || current.length >= chunkSize) {
      current = [];
      chunks.push(current);
    }
    current.push(t);
    homeByKey.set(key, current);
  }
  return chunks;
}

/** Sum two positive-or-negative 4dp decimal strings exactly (no floats). */
function amountToMicros4dp(s: string): bigint {
  const negative = s.startsWith('-');
  const [whole = '0', frac = ''] = (negative ? s.slice(1) : s).split('.');
  const micros = BigInt(whole) * 10000n + BigInt((frac + '0000').slice(0, 4));
  return negative ? -micros : micros;
}

function microsToDecimal4dp(m: bigint): string {
  const neg = m < 0n;
  const abs = neg ? -m : m;
  return `${neg ? '-' : ''}${abs / 10000n}.${(abs % 10000n).toString().padStart(4, '0')}`;
}

/**
 * Merge per-chunk commit results into the single summary the completion
 * screen renders: counters sum, error/warning lists concatenate, and
 * unlinked payees re-aggregate case-insensitively with exact decimal totals.
 */
export function mergeTransactionCommitResults(
  results: readonly TransactionCommitResultLike[],
): TransactionCommitResultLike {
  const merged: TransactionCommitResultLike = {
    posted: 0,
    skipped: 0,
    duplicates: 0,
    voided: 0,
    paymentsLinked: 0,
    paymentsBackfilled: 0,
    unlinkedPayees: [],
    warnings: [],
    errors: [],
  };
  const unlinked = new Map<string, { name: string; count: number; totalMicros: bigint }>();
  const seenWarnings = new Set<string>();
  for (const r of results) {
    merged.posted += r.posted;
    merged.skipped += r.skipped;
    merged.duplicates += r.duplicates;
    merged.voided += r.voided;
    merged.paymentsLinked += r.paymentsLinked;
    merged.paymentsBackfilled += r.paymentsBackfilled ?? 0;
    for (const p of r.unlinkedPayees ?? []) {
      const key = p.name.toLowerCase();
      const agg = unlinked.get(key) ?? { name: p.name, count: 0, totalMicros: 0n };
      agg.count += p.count;
      agg.totalMicros += amountToMicros4dp(p.total);
      unlinked.set(key, agg);
    }
    // Chunk-invariant disclosures (the A/R / A/P subledger notes) come back
    // identically from every chunk; a CPA seeing the same paragraph six times
    // reads it as a bug, so identical texts collapse to one. Per-row warnings
    // name their row number and stay distinct.
    for (const w of r.warnings ?? []) {
      if (seenWarnings.has(w)) continue;
      seenWarnings.add(w);
      merged.warnings!.push(w);
    }
    merged.errors.push(...r.errors);
  }
  merged.unlinkedPayees = Array.from(unlinked.values())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => ({ name: a.name, count: a.count, total: microsToDecimal4dp(a.totalMicros) }));
  return merged;
}

/** Rows per lists-commit request. The server awaits one INSERT per account/
 * customer/vendor row (plus a parent-link UPDATE per sub-account), so a
 * 12-year company file's lists -- several thousand customers and vendors is
 * routine -- sent as ONE request blows the same 60s platform caps the
 * transactions leg chunks around, rolls the whole commit back, and fails
 * identically on every retry. */
export const LISTS_COMMIT_CHUNK_SIZE = 500;

export interface ListsCommitPayload<A, C, V> {
  accounts: A[];
  customers: C[];
  vendors: V[];
}

export interface ListsCommitResultLike {
  accountsCreated: number;
  accountsSkipped: number;
  customersCreated: number;
  customersSkipped: number;
  vendorsCreated: number;
  vendorsSkipped: number;
  conflicts: { kind: 'account' | 'customer' | 'vendor'; identifier: string; reason: string }[];
  warnings: string[];
}

/**
 * Split a lists commit into bounded request payloads. Accounts sharing a
 * colon-path ROOT ("Utilities", "Utilities:Gas & Electric") always travel
 * in the same chunk: the server's parent-linking pass runs per request, and
 * while a parent that landed in an EARLIER chunk is found again via the DB,
 * a parent split into a LATER chunk would leave the child unlinked. The
 * server's skip-on-name-conflict makes every chunk idempotent, so a
 * mid-sequence failure is resumable by clicking Confirm again. A chunk can
 * exceed chunkSize by the size of one root group; groups are almost always
 * tiny. An all-empty commit still yields one (empty) request so the flow
 * keeps returning a result object.
 */
export function chunkListsForCommit<A extends { name: string }, C, V>(
  lists: { accounts: readonly A[]; customers: readonly C[]; vendors: readonly V[] },
  chunkSize = LISTS_COMMIT_CHUNK_SIZE,
): ListsCommitPayload<A, C, V>[] {
  const chunks: ListsCommitPayload<A, C, V>[] = [];
  let current: ListsCommitPayload<A, C, V> | null = null;
  const sizeOf = (c: ListsCommitPayload<A, C, V>) =>
    c.accounts.length + c.customers.length + c.vendors.length;
  const next = (): ListsCommitPayload<A, C, V> => {
    if (!current || sizeOf(current) >= chunkSize) {
      current = { accounts: [], customers: [], vendors: [] };
      chunks.push(current);
    }
    return current;
  };
  const accountHomeByRoot = new Map<string, ListsCommitPayload<A, C, V>>();
  for (const a of lists.accounts) {
    const colon = a.name.indexOf(':');
    const root = (colon > 0 ? a.name.slice(0, colon) : a.name).trim().toLowerCase();
    const home = accountHomeByRoot.get(root);
    if (home) {
      home.accounts.push(a);
      continue;
    }
    const chunk = next();
    chunk.accounts.push(a);
    accountHomeByRoot.set(root, chunk);
  }
  for (const c of lists.customers) next().customers.push(c);
  for (const v of lists.vendors) next().vendors.push(v);
  if (chunks.length === 0) chunks.push({ accounts: [], customers: [], vendors: [] });
  return chunks;
}

/** Merge per-chunk lists-commit results into the single summary the
 * completion screen renders: counters sum, conflict/warning lists
 * concatenate (chunks never overlap rows, so nothing double-counts). */
export function mergeListsCommitResults(
  results: readonly ListsCommitResultLike[],
): ListsCommitResultLike {
  const merged: ListsCommitResultLike = {
    accountsCreated: 0,
    accountsSkipped: 0,
    customersCreated: 0,
    customersSkipped: 0,
    vendorsCreated: 0,
    vendorsSkipped: 0,
    conflicts: [],
    warnings: [],
  };
  for (const r of results) {
    merged.accountsCreated += r.accountsCreated;
    merged.accountsSkipped += r.accountsSkipped;
    merged.customersCreated += r.customersCreated;
    merged.customersSkipped += r.customersSkipped;
    merged.vendorsCreated += r.vendorsCreated;
    merged.vendorsSkipped += r.vendorsSkipped;
    merged.conflicts.push(...r.conflicts);
    merged.warnings.push(...r.warnings);
  }
  return merged;
}

/** Everything a chunked commit had landed at the moment it failed. */
export interface PartialCommitProgress {
  lists: ListsCommitResultLike;
  txns: TransactionCommitResultLike;
  listChunksDone: number;
  listChunksTotal: number;
  txnChunksDone: number;
  txnChunksTotal: number;
}

/** Fresh zeroed result (a factory, not a shared constant: the arrays must not
 * be aliased between the value a caller keeps and the next one built). */
const emptyTxResult = (): TransactionCommitResultLike => ({
  posted: 0,
  skipped: 0,
  duplicates: 0,
  voided: 0,
  paymentsLinked: 0,
  paymentsBackfilled: 0,
  warnings: [],
  unlinkedPayees: [],
  errors: [],
});

/**
 * Run the two-leg commit (lists first, then transactions) one chunk per
 * request, and hand back the merged result.
 *
 * The reason this is a function rather than two loops in the component: each
 * chunk is its own server-side DB transaction, so a failure on chunk 4 does
 * NOT roll back chunks 1-3 -- they are permanently on the ledger. Letting the
 * rejection propagate with nothing else happening threw away the only record
 * of what landed, and the user saw a bare "API 504" over an untouched-looking
 * preview while the trial balance already held half the file. `onPartial`
 * receives that record before the error is rethrown so the UI can report the
 * committed batches and point at the resume path (clicking Confirm again is
 * safe -- the server skips what already landed as duplicates).
 */
export async function runChunkedCommit<
  A extends { name: string },
  C,
  V,
  T extends CommitTransactionLike,
>(args: {
  lists: { accounts: readonly A[]; customers: readonly C[]; vendors: readonly V[] };
  transactions: readonly T[];
  sendLists: (chunk: ListsCommitPayload<A, C, V>) => Promise<ListsCommitResultLike>;
  sendTransactions: (chunk: T[]) => Promise<TransactionCommitResultLike>;
  onPartial: (progress: PartialCommitProgress) => void;
}): Promise<{ listsResult: ListsCommitResultLike; txResult: TransactionCommitResultLike }> {
  const listChunks = chunkListsForCommit(args.lists);
  const txChunks = args.transactions.length > 0 ? chunkTransactionsForCommit(args.transactions) : [];
  const listResults: ListsCommitResultLike[] = [];
  const txResults: TransactionCommitResultLike[] = [];
  try {
    for (const chunk of listChunks) listResults.push(await args.sendLists(chunk));
    for (const chunk of txChunks) txResults.push(await args.sendTransactions(chunk));
  } catch (err) {
    args.onPartial({
      lists: mergeListsCommitResults(listResults),
      txns: { ...emptyTxResult(), ...mergeTransactionCommitResults(txResults) },
      listChunksDone: listResults.length,
      listChunksTotal: listChunks.length,
      txnChunksDone: txResults.length,
      txnChunksTotal: txChunks.length,
    });
    throw err;
  }
  return {
    listsResult: mergeListsCommitResults(listResults),
    txResult:
      txChunks.length > 0
        ? { ...emptyTxResult(), ...mergeTransactionCommitResults(txResults) }
        : emptyTxResult(),
  };
}

/**
 * Commit-time guard on the company binding. The preview was parsed against
 * ONE company's chart, but every commit request is scoped by whichever
 * company the header dropdown points at NOW -- and nothing server-side ties
 * a preview to its commit. If the user flips companies with a preview still
 * open, confirming would import one client's entire books into another
 * client's ledger (missing accounts auto-create, so it mostly SUCCEEDS).
 * The Imports component resets the flow when the company changes; this
 * throw is the backstop for any render race in between.
 */
export function assertCommitCompanyUnchanged(
  previewCompanyId: string | null,
  activeCompanyId: string | null,
): void {
  if (!previewCompanyId || !activeCompanyId || previewCompanyId !== activeCompanyId) {
    throw new Error(
      'The active company changed since this file was previewed. To avoid importing into ' +
        'the wrong company, nothing was committed — switch to the intended company and ' +
        'upload the file again.',
    );
  }
}
