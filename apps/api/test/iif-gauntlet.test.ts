/**
 * IIF commit gauntlet: regression tests for the commit paths
 * (commitIifImport + commitIifTransactions) using a stubbed drizzle tx.
 * Covers the day-one QBD migration hazards:
 *   - seeded-chart code collisions must renumber, never drop accounts
 *   - name conflicts still skip (idempotent re-import)
 *   - 1099 vendors without TINs import with a warning instead of vanishing
 *   - voided checks (all-zero blocks) are counted, not reported as errors
 *   - a per-company advisory lock guards the read-then-write dedupe
 *   - class / customer / vendor names land in journal_lines.dimension_json
 *   - closed-period / impossible-date rows fail per-row, never the batch
 *   - each block posts inside a savepoint so one SQL failure can't poison
 *     the outer transaction
 *   - vendor checks / customer payments also land in the payments subledger
 *     (1099 totals, payroll register, statements)
 *   - colon-path sub-accounts get parent_id links; customer:job flattening
 *     is disclosed via a warning
 *   - HIDDEN=Y (inactive-in-QBD) rows commit as inactive
 *   - vendor/customer addresses persist; 1099 vendors without one warn
 *   - the duplicate pre-scan chunks its inArray so a huge re-import can't
 *     blow the driver's bind-parameter limit
 *   - money-out blocks whose payee matches nobody are disclosed per payee
 *   - duplicate skips backfill missing payments links (fix-and-re-import)
 *     and still-unlinked duplicates keep the per-payee disclosure alive
 *   - a posted block sharing date+reference with a different existing entry
 *     warns (transaction edited in QBD after an earlier import)
 *   - pre-existing case-twin account names resolve exact-cased or fail
 *     per-row -- never by unordered-scan luck
 *   - DB-inactive accounts referenced by a transactions-only file are
 *     disclosed at preview (the two-file lists-then-transactions migration)
 *   - upload decoding (UTF-16 re-saves), client commit chunking/merging, and
 *     the preview's "Maps to" label (shared web helpers, tested here with
 *     the parser/committer they feed)
 *   - a file-content source_id stamped on every posted entry makes duplicate
 *     detection survive account renames between imports (the accountId
 *     fingerprint alone re-posted the whole file after a rename)
 *   - skipped name-conflict accounts disclose a type disagreement with the
 *     stored account (transactions-first imports leave heuristic guesses)
 *   - the lists commit is chunked client-side like the transactions leg
 *     (one unchunked request timed out on large QBD lists), with colon-path
 *     families kept per-chunk so parent linking still works
 *   - the commit company must match the preview company (cross-tenant
 *     import guard for a still-open preview after a company switch)
 *
 * True concurrency and RLS behaviour are integration concerns (packages/db
 * harness); these tests pin the unit-level contracts.
 */
import { describe, expect, it } from 'vitest';
import type { Database } from '@kpbooks/db';
import {
  accounts as accountsTable,
  companies as companiesTable,
  customers as customersTable,
  journalEntries,
  journalLines,
  payments as paymentsTable,
  vendors as vendorsTable,
} from '@kpbooks/db';
import {
  CommitIifSchema,
  CommitIifTransactionsSchema,
  buildMissingAccounts,
  commitIifImport,
  commitIifTransactions,
  parseIif,
  warnInactiveAccountRefs,
} from '../src/modules/imports/iif.js';
import { PreviewBody } from '../src/routes/imports.js';
import { decodeIifBuffer } from '../../web/src/lib/decode-iif';
import {
  assertCommitCompanyUnchanged,
  chunkListsForCommit,
  chunkTransactionsForCommit,
  mergeListsCommitResults,
  mergeTransactionCommitResults,
} from '../../web/src/lib/iif-commit';
import { mapsToLabel } from '../../web/src/lib/iif-preview';

const ctx = {
  companyId: 'c0000000-0000-4000-8000-000000000001',
  userId: 'a0000000-0000-4000-8000-00000000000a',
};

const CHECKING_ID = 'a0000000-0000-4000-8000-000000000001';
const EXPENSE_ID = 'a0000000-0000-4000-8000-000000000002';

type Row = Record<string, unknown>;

interface StubData {
  accounts?: Row[];
  companies?: Row[];
  customers?: Row[];
  vendors?: Row[];
  journalEntries?: Row[];
  journalLines?: Row[];
  /** Rows for the payments pre-scan, shaped like its select:
   * `{ entryId: <postedJournalEntryId> }`. */
  payments?: Row[];
  /** Inject a SQL-style failure: journal_entries inserts whose entryDate is
   * listed here reject, simulating a trigger/constraint blowing up mid-import. */
  failJournalEntryDates?: string[];
}

/** Extract the literal text of a drizzle sql`` tag (params omitted). */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks ?? [];
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown }).value;
      return Array.isArray(v) ? v.join('') : '';
    })
    .join('');
}

/**
 * Minimal drizzle-shaped stub: enough of select/from/where, insert/values/
 * returning, and execute for the iif commit paths (including postEntry and
 * recordActivity). Selects return canned rows per table; inserts are captured
 * for assertions; execute records the SQL text so lock-ordering is testable.
 */
function makeStubTx(data: StubData) {
  const ops: string[] = [];
  const inserted = new Map<unknown, Row[]>();
  const updated = new Map<unknown, Row[]>();
  let insertSeq = 0;

  const tableName = (table: unknown): string => {
    if (table === accountsTable) return 'accounts';
    if (table === companiesTable) return 'companies';
    if (table === customersTable) return 'customers';
    if (table === vendorsTable) return 'vendors';
    if (table === journalEntries) return 'journal_entries';
    if (table === journalLines) return 'journal_lines';
    if (table === paymentsTable) return 'payments';
    return 'other';
  };
  const rowsFor = (table: unknown): Row[] => {
    if (table === accountsTable) return data.accounts ?? [];
    if (table === companiesTable) return data.companies ?? [];
    if (table === customersTable) return data.customers ?? [];
    if (table === vendorsTable) return data.vendors ?? [];
    if (table === journalEntries) return data.journalEntries ?? [];
    if (table === journalLines) return data.journalLines ?? [];
    if (table === paymentsTable) return data.payments ?? [];
    return [];
  };

  const tx = {
    execute: (query: unknown) => {
      ops.push(`execute:${sqlText(query)}`);
      return Promise.resolve([]);
    },
    // Nested drizzle transaction (savepoint). The stub can't roll anything
    // back; it exists so the per-block savepoint code path is exercised and
    // its use is assertable via ops.
    transaction: (fn: (inner: unknown) => Promise<unknown>) => {
      ops.push('savepoint');
      return fn(tx);
    },
    select: () => ({
      from: (table: unknown) => {
        ops.push(`select:${tableName(table)}`);
        const rows = rowsFor(table);
        return {
          where: () => Promise.resolve(rows),
          then: (
            onFulfilled?: (rows: Row[]) => unknown,
            onRejected?: (err: unknown) => unknown,
          ) => Promise.resolve(rows).then(onFulfilled, onRejected),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (v: Row | Row[]) => {
        const list = Array.isArray(v) ? v : [v];
        if (table === journalEntries && data.failJournalEntryDates) {
          const bad = list.find((r) =>
            data.failJournalEntryDates!.includes(String(r.entryDate)),
          );
          if (bad) {
            ops.push('insert:journal_entries:FAIL');
            const err = Object.assign(new Error('injected insert failure'), { code: 'XX000' });
            return Object.assign(Promise.resolve([]), {
              returning: () => Promise.reject(err),
            });
          }
        }
        ops.push(`insert:${tableName(table)}`);
        const bucket = inserted.get(table) ?? [];
        bucket.push(...list);
        inserted.set(table, bucket);
        insertSeq++;
        const id = `e0000000-0000-4000-8000-${String(insertSeq).padStart(12, '0')}`;
        return Object.assign(Promise.resolve([]), {
          returning: () => Promise.resolve([{ id }]),
        });
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Row) => ({
        where: () => {
          ops.push(`update:${tableName(table)}`);
          const bucket = updated.get(table) ?? [];
          bucket.push(patch);
          updated.set(table, bucket);
          return Promise.resolve([]);
        },
      }),
    }),
  };
  return { tx: tx as unknown as Database, ops, inserted, updated };
}

describe('commitIifImport account code conflicts', () => {
  it('renumbers instead of skipping when a new account name hits a seeded code', () => {
    // Every company is seeded with DEFAULT_COA, which already uses 1010 --
    // exactly what the parser suggests for the file's first bank account.
    const { tx, inserted } = makeStubTx({
      accounts: [{ code: '1010', name: 'Checking Account' }],
    });
    const input = CommitIifSchema.parse({
      accounts: [
        { name: 'First National Checking', type: 'asset', subtype: 'bank', code: '1010' },
      ],
    });
    return commitIifImport(tx, ctx, input).then((result) => {
      expect(result.accountsCreated).toBe(1);
      expect(result.accountsSkipped).toBe(0);
      expect(result.conflicts).toEqual([]);
      expect(result.warnings.some((w) => /1010/.test(w) && /1011/.test(w))).toBe(true);
      const rows = inserted.get(accountsTable)!;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.code).toBe('1011');
      expect(rows[0]?.name).toBe('First National Checking');
    });
  });

  it('renumber fallback also steps over codes created earlier in the same import', async () => {
    const { tx, inserted } = makeStubTx({
      accounts: [{ code: '1010', name: 'Checking Account' }],
    });
    const input = CommitIifSchema.parse({
      accounts: [
        { name: 'First National Checking', type: 'asset', subtype: 'bank', code: '1010' },
        { name: 'Payroll Checking', type: 'asset', subtype: 'bank', code: '1010' },
      ],
    });
    const result = await commitIifImport(tx, ctx, input);
    expect(result.accountsCreated).toBe(2);
    const codes = (inserted.get(accountsTable) ?? []).map((r) => r.code);
    expect(codes).toEqual(['1011', '1012']);
    expect(result.warnings).toHaveLength(2);
  });

  it('still skips on name conflict so re-importing the same file is a no-op', async () => {
    const { tx, inserted } = makeStubTx({
      accounts: [{ code: '1011', name: 'First National Checking' }],
    });
    const input = CommitIifSchema.parse({
      accounts: [
        // Same name, case differs, code differs -- must skip, never duplicate.
        { name: 'FIRST NATIONAL CHECKING', type: 'asset', subtype: 'bank', code: '1010' },
      ],
    });
    const result = await commitIifImport(tx, ctx, input);
    expect(result.accountsCreated).toBe(0);
    expect(result.accountsSkipped).toBe(1);
    expect(result.conflicts[0]?.reason).toBe('name already exists');
    expect(inserted.get(accountsTable)).toBeUndefined();
  });

  it('takes the per-company advisory lock before reading the chart', async () => {
    const { tx, ops } = makeStubTx({ accounts: [] });
    const input = CommitIifSchema.parse({
      accounts: [{ name: 'Checking', type: 'asset', subtype: 'bank', code: '1010' }],
    });
    await commitIifImport(tx, ctx, input);
    const lockIdx = ops.findIndex(
      (o) => o.startsWith('execute:') && o.includes('pg_advisory_xact_lock'),
    );
    const selectIdx = ops.findIndex((o) => o === 'select:accounts');
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(selectIdx).toBeGreaterThan(lockIdx);
  });
});

describe('commitIifImport 1099 vendors', () => {
  it('imports 1099-flagged vendors without a tax ID and warns instead of dropping them', async () => {
    const { tx, inserted } = makeStubTx({ vendors: [] });
    const input = CommitIifSchema.parse({
      vendors: [{ displayName: 'Joe Subcontractor', is1099Vendor: true }],
    });
    const result = await commitIifImport(tx, ctx, input);
    expect(result.vendorsCreated).toBe(1);
    expect(result.vendorsSkipped).toBe(0);
    expect(result.warnings.some((w) => /Joe Subcontractor/.test(w) && /tax ID/i.test(w))).toBe(
      true,
    );
    const rows = inserted.get(vendorsTable)!;
    expect(rows[0]?.is1099Vendor).toBe(true);
    expect(rows[0]?.taxId).toBeNull();
  });

  it('persists vendor mailing addresses and warns when a 1099 vendor has none', async () => {
    // 1099-NEC forms need the recipient street/city/state/ZIP just as much
    // as the TIN; addresses used to be silently dropped at import.
    const { tx, inserted } = makeStubTx({ vendors: [] });
    const input = CommitIifSchema.parse({
      vendors: [
        {
          displayName: 'Joe Subcontractor',
          is1099Vendor: true,
          taxId: '12-3456789',
          mailingAddress: { street1: '123 Main St', city: 'Austin', state: 'TX', postalCode: '78701' },
        },
        { displayName: 'No Address Sub', is1099Vendor: true, taxId: '98-7654321' },
      ],
    });
    const result = await commitIifImport(tx, ctx, input);
    const rows = inserted.get(vendorsTable)!;
    expect(rows[0]?.mailingAddress).toEqual({
      street1: '123 Main St',
      city: 'Austin',
      state: 'TX',
      postalCode: '78701',
    });
    expect(rows[1]?.mailingAddress).toBeNull();
    expect(
      result.warnings.some((w) => /No Address Sub/.test(w) && /mailing address/.test(w)),
    ).toBe(true);
    expect(
      result.warnings.some((w) => /Joe Subcontractor/.test(w) && /mailing address/.test(w)),
    ).toBe(false);
  });
});

describe('commitIifImport list fidelity', () => {
  it('persists customer billing and shipping addresses', async () => {
    const { tx, inserted } = makeStubTx({ customers: [] });
    const input = CommitIifSchema.parse({
      customers: [
        {
          displayName: 'Acme Corp',
          billingAddress: { street1: '500 Elm St', city: 'Dallas', state: 'TX', postalCode: '75201' },
          shippingAddress: { street1: '12 Warehouse Rd', city: 'Plano', state: 'TX', postalCode: '75093' },
        },
      ],
    });
    await commitIifImport(tx, ctx, input);
    const rows = inserted.get(customersTable)!;
    expect(rows[0]?.billingAddress).toEqual({
      street1: '500 Elm St',
      city: 'Dallas',
      state: 'TX',
      postalCode: '75201',
    });
    expect(rows[0]?.shippingAddress).toEqual({
      street1: '12 Warehouse Rd',
      city: 'Plano',
      state: 'TX',
      postalCode: '75093',
    });
  });

  it('imports HIDDEN=Y rows as inactive across accounts, customers, and vendors', async () => {
    const { tx, inserted } = makeStubTx({ accounts: [], customers: [], vendors: [] });
    const input = CommitIifSchema.parse({
      accounts: [
        { name: 'Old Checking', type: 'asset', subtype: 'bank', code: '1010', isActive: false },
        { name: 'Checking', type: 'asset', subtype: 'bank', code: '1020' },
      ],
      customers: [{ displayName: 'Defunct Customer', isActive: false }],
      vendors: [{ displayName: 'Closed Vendor', isActive: false }],
    });
    const result = await commitIifImport(tx, ctx, input);
    expect(result.accountsCreated).toBe(2);
    const accountRows = inserted.get(accountsTable)!;
    expect(accountRows.find((r) => r.name === 'Old Checking')?.isActive).toBe(false);
    expect(accountRows.find((r) => r.name === 'Checking')?.isActive).toBe(true);
    expect(inserted.get(customersTable)?.[0]?.isActive).toBe(false);
    expect(inserted.get(vendorsTable)?.[0]?.isActive).toBe(false);
  });

  it('a file with Net 400 terms previews AND validates for commit (no whole-request 400)', () => {
    const t = '\t';
    const preview = parseIif(
      [`!VEND${t}NAME${t}TERMS`, `VEND${t}Slow Pay Vendor${t}Net 400`].join('\n'),
    );
    // Exactly what the UI submits: parsed rows with undefined keys stripped.
    const body = {
      accounts: [],
      customers: [],
      vendors: preview.vendors.map((v) =>
        Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined)),
      ),
    };
    const parsed = CommitIifSchema.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(preview.warnings.some((w) => /exceed Net 365/.test(w))).toBe(true);
  });
});

describe('commitIifTransactions', () => {
  const chartRows: Row[] = [
    {
      id: CHECKING_ID,
      name: 'Checking',
      isActive: true,
      companyId: ctx.companyId,
      currency: 'USD',
    },
    {
      id: EXPENSE_ID,
      name: 'Office Expense',
      isActive: true,
      companyId: ctx.companyId,
      currency: 'USD',
    },
  ];

  it('counts all-zero (voided check) blocks as voided, not as errors', async () => {
    const { tx, inserted } = makeStubTx({ accounts: chartRows, journalEntries: [] });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [
        {
          rowNumber: 4,
          qbType: 'CHECK',
          sourceType: 'bank_transaction',
          posts: true,
          date: '2026-03-10',
          memo: 'VOID: check 1044',
          lines: [
            { account: 'Checking', amount: '0.0000', memo: 'VOID: check 1044' },
            { account: 'Office Expense', amount: '0.0000' },
          ],
        },
      ],
    });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.voided).toBe(1);
    expect(result.posted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(result.errors).toEqual([]);
    expect(inserted.get(journalEntries)).toBeUndefined();
  });

  it('still reports an error when exactly one non-zero line survives', async () => {
    const { tx } = makeStubTx({ accounts: chartRows, journalEntries: [] });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [
        {
          rowNumber: 9,
          qbType: 'CHECK',
          sourceType: 'bank_transaction',
          posts: true,
          date: '2026-03-11',
          lines: [
            { account: 'Checking', amount: '0.0000' },
            { account: 'Office Expense', amount: '75.0000' },
          ],
        },
      ],
    });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.voided).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]?.reason).toBe('fewer than 2 non-zero lines');
  });

  it('takes the per-company advisory lock before scanning for duplicates', async () => {
    const { tx, ops } = makeStubTx({ accounts: chartRows, journalEntries: [] });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [
        {
          rowNumber: 1,
          qbType: 'CHECK',
          sourceType: 'bank_transaction',
          posts: true,
          date: '2026-03-10',
          lines: [
            { account: 'Checking', amount: '-75.0000' },
            { account: 'Office Expense', amount: '75.0000' },
          ],
        },
      ],
    });
    await commitIifTransactions(tx, ctx, input);
    const lockIdx = ops.findIndex(
      (o) => o.startsWith('execute:') && o.includes('pg_advisory_xact_lock'),
    );
    const fingerprintIdx = ops.findIndex((o) => o === 'select:journal_entries');
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(fingerprintIdx).toBeGreaterThan(lockIdx);
  });

  it('preserves per-line class and name in journal_lines.dimension_json', async () => {
    const { tx, inserted } = makeStubTx({ accounts: chartRows, journalEntries: [] });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [
        {
          rowNumber: 2,
          qbType: 'CHECK',
          sourceType: 'bank_transaction',
          posts: true,
          date: '2026-03-12',
          docNum: '1051',
          lines: [
            {
              account: 'Checking',
              amount: '-75.0000',
              name: 'Office Supply Co',
              classRef: 'Uptown',
            },
            { account: 'Office Expense', amount: '75.0000', classRef: 'Uptown' },
          ],
        },
      ],
    });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.posted).toBe(1);
    expect(result.errors).toEqual([]);
    const lineRows = inserted.get(journalLines)!;
    expect(lineRows).toHaveLength(2);
    const creditLine = lineRows.find((l) => l.accountId === CHECKING_ID)!;
    expect(creditLine.dimensionJson).toEqual({ class: 'Uptown', name: 'Office Supply Co' });
    const debitLine = lineRows.find((l) => l.accountId === EXPENSE_ID)!;
    expect(debitLine.dimensionJson).toEqual({ class: 'Uptown' });
  });

  const checkBlock = (rowNumber: number, date: string, name?: string) => ({
    rowNumber,
    qbType: 'CHECK',
    sourceType: 'bank_transaction' as const,
    posts: true,
    date,
    lines: [
      { account: 'Checking', amount: '-75.0000', ...(name ? { name } : {}) },
      { account: 'Office Expense', amount: '75.0000' },
    ],
  });

  it('skips back-dated blocks against closed_through_date per-row instead of dooming the batch', async () => {
    // The closed-period guard is a plain BEFORE INSERT trigger; if it fired
    // mid-import it would abort the whole Postgres transaction (25P02 on
    // every later statement) and 500 the request. The pre-check must turn a
    // back-dated check into ONE per-row error while the valid rows post.
    const { tx, inserted } = makeStubTx({
      accounts: chartRows,
      companies: [{ closedThroughDate: '2025-12-31' }],
      journalEntries: [],
    });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [
        checkBlock(3, '2025-12-15'), // inside the closed period
        checkBlock(7, '2025-12-31'), // boundary: closed-through day itself is blocked
        checkBlock(11, '2026-01-15'), // open period -- must still post
      ],
    });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.posted).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.map((e) => e.rowNumber).sort()).toEqual([3, 7]);
    for (const e of result.errors) expect(e.reason).toMatch(/closed period/);
    expect(inserted.get(journalEntries)).toHaveLength(1);
    expect(inserted.get(journalEntries)?.[0]?.entryDate).toBe('2026-01-15');
  });

  it('re-import of entries that predate a later close reads as duplicates, not closed-period errors', async () => {
    // Fingerprint the already-posted copy of the back-dated check so the
    // duplicate guard fires BEFORE the closed-period check.
    const { tx } = makeStubTx({
      accounts: chartRows,
      companies: [{ closedThroughDate: '2025-12-31' }],
      journalEntries: [
        { id: 'e1111111-0000-4000-8000-000000000001', entryDate: '2025-12-15', memo: null, reference: null },
      ],
      journalLines: [
        {
          entryId: 'e1111111-0000-4000-8000-000000000001',
          accountId: CHECKING_ID,
          debit: '0',
          credit: '75.0000',
        },
        {
          entryId: 'e1111111-0000-4000-8000-000000000001',
          accountId: EXPENSE_ID,
          debit: '75.0000',
          credit: '0',
        },
      ],
    });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [checkBlock(3, '2025-12-15')],
    });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.duplicates).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it('reports an impossible calendar date as a per-row error, not a batch failure', async () => {
    // "2026-02-31" passes the zod shape regex but Postgres would reject the
    // literal (22008) -- and the fingerprint pre-scan runs BEFORE the loop,
    // so without the guard one corrupt row would 500 the entire commit.
    const { tx, inserted } = makeStubTx({ accounts: chartRows, journalEntries: [] });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [checkBlock(4, '2026-02-31'), checkBlock(8, '2026-03-01')],
    });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.posted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.rowNumber).toBe(4);
    expect(result.errors[0]?.reason).toMatch(/invalid calendar date/);
    expect(inserted.get(journalEntries)).toHaveLength(1);
  });

  it('posts each block inside a savepoint so one SQL failure cannot poison later blocks', async () => {
    const { tx, inserted, ops } = makeStubTx({
      accounts: chartRows,
      journalEntries: [],
      failJournalEntryDates: ['2026-04-01'],
    });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [checkBlock(2, '2026-04-01'), checkBlock(6, '2026-04-02')],
    });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.posted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]?.rowNumber).toBe(2);
    expect(result.errors[0]?.reason).toMatch(/injected insert failure/);
    expect(inserted.get(journalEntries)).toHaveLength(1);
    // Both attempts must have run inside a nested transaction (savepoint).
    expect(ops.filter((o) => o === 'savepoint')).toHaveLength(2);
    // The savepoint opens before the entry insert is attempted.
    expect(ops.indexOf('savepoint')).toBeLessThan(ops.indexOf('insert:journal_entries:FAIL'));
  });

  it('chunks the duplicate pre-scan inArray so >10k prior entries cannot blow the bind-parameter limit', async () => {
    // postgres.js hard-rejects any statement with >= 65,534 bind parameters
    // (MAX_PARAMETERS_EXCEEDED). A multi-year re-import can put more entry
    // ids on the file's dates than that -- the scan also sweeps entries from
    // other work on the same dates -- and one unchunked inArray aborted the
    // whole commit exactly when the fix-and-re-run workflow needed the
    // duplicate scan most. 10,001 entries must produce two chunked queries.
    const manyEntries = Array.from({ length: 10_001 }, (_, i) => ({
      id: `e2222222-0000-4000-8000-${String(i).padStart(12, '0')}`,
      entryDate: '2026-07-01',
      memo: null,
      reference: null,
    }));
    const { tx, ops } = makeStubTx({
      accounts: chartRows,
      journalEntries: manyEntries,
      journalLines: [],
    });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [checkBlock(2, '2026-07-01')],
    });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.posted).toBe(1);
    expect(result.errors).toEqual([]);
    expect(ops.filter((o) => o === 'select:journal_lines')).toHaveLength(2);
  });
});

describe('commitIifTransactions payments subledger linkage', () => {
  const VENDOR_ID = 'b0000000-0000-4000-8000-000000000001';
  const CUSTOMER_ID = 'b0000000-0000-4000-8000-000000000002';
  const chartRows: Row[] = [
    { id: CHECKING_ID, name: 'Checking', isActive: true, companyId: ctx.companyId, currency: 'USD' },
    { id: EXPENSE_ID, name: 'Office Expense', isActive: true, companyId: ctx.companyId, currency: 'USD' },
  ];

  it('writes a vendor_sent payments row for a check whose NAME matches a vendor', async () => {
    // 1099-NEC totals sum strictly from the payments table, so a GL-only
    // import would understate every January 1099 for a mid-year migration.
    const { tx, inserted } = makeStubTx({
      accounts: chartRows,
      vendors: [{ id: VENDOR_ID, name: 'Joe Subcontractor' }],
      journalEntries: [],
    });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [
        {
          rowNumber: 5,
          qbType: 'CHECK',
          sourceType: 'bank_transaction',
          posts: true,
          date: '2026-05-01',
          docNum: '1077',
          reference: '1077',
          lines: [
            { account: 'Checking', amount: '-2500.0000', name: 'Joe Subcontractor' },
            { account: 'Office Expense', amount: '2500.0000' },
          ],
        },
      ],
    });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.posted).toBe(1);
    expect(result.paymentsLinked).toBe(1);
    const payRows = inserted.get(paymentsTable)!;
    expect(payRows).toHaveLength(1);
    expect(payRows[0]).toMatchObject({
      paymentType: 'vendor_sent',
      vendorId: VENDOR_ID,
      customerId: null,
      paymentMethod: 'check',
      amount: '2500.0000',
      bankAccountId: CHECKING_ID,
      paymentDate: '2026-05-01',
      reference: '1077',
      status: 'posted',
    });
    expect(payRows[0]?.postedJournalEntryId).toBeTruthy();
  });

  it('writes a customer_received payments row for a PAYMENT whose NAME matches a customer', async () => {
    const { tx, inserted } = makeStubTx({
      accounts: chartRows,
      customers: [{ id: CUSTOMER_ID, name: 'Acme Corp' }],
      journalEntries: [],
    });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [
        {
          rowNumber: 9,
          qbType: 'PAYMENT',
          sourceType: 'payment',
          posts: true,
          date: '2026-05-02',
          lines: [
            { account: 'Checking', amount: '500.0000', name: 'Acme Corp' },
            { account: 'Office Expense', amount: '-500.0000' },
          ],
        },
      ],
    });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.posted).toBe(1);
    expect(result.paymentsLinked).toBe(1);
    const payRows = inserted.get(paymentsTable)!;
    expect(payRows[0]).toMatchObject({
      paymentType: 'customer_received',
      customerId: CUSTOMER_ID,
      vendorId: null,
      amount: '500.0000',
      bankAccountId: CHECKING_ID,
    });
  });

  it('stays GL-only when the NAME matches nobody or the type is not a money movement', async () => {
    const { tx, inserted } = makeStubTx({
      accounts: chartRows,
      vendors: [{ id: VENDOR_ID, name: 'Joe Subcontractor' }],
      journalEntries: [],
    });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [
        {
          // Unknown payee -- no subledger row.
          rowNumber: 2,
          qbType: 'CHECK',
          sourceType: 'bank_transaction',
          posts: true,
          date: '2026-06-01',
          lines: [
            { account: 'Checking', amount: '-10.0000', name: 'Somebody Unknown' },
            { account: 'Office Expense', amount: '10.0000' },
          ],
        },
        {
          // GENERAL JOURNAL is not a money movement even with a vendor name.
          rowNumber: 6,
          qbType: 'GENERAL JOURNAL',
          sourceType: 'manual',
          posts: true,
          date: '2026-06-02',
          lines: [
            { account: 'Checking', amount: '-20.0000', name: 'Joe Subcontractor' },
            { account: 'Office Expense', amount: '20.0000' },
          ],
        },
      ],
    });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.posted).toBe(2);
    expect(result.paymentsLinked).toBe(0);
    expect(inserted.get(paymentsTable)).toBeUndefined();
    // The unknown-payee CHECK is a money movement that failed to link and
    // must be disclosed; the GENERAL JOURNAL is not a money movement and
    // must NOT be.
    expect(result.unlinkedPayees).toEqual([
      { name: 'Somebody Unknown', count: 1, total: '10.0000' },
    ]);
  });

  it('aggregates GL-only money-out blocks per payee so 1099/payroll shortfalls are actionable', async () => {
    // 52 checks payable to "J. Smith Concrete" while the vendor row reads
    // "J Smith Concrete" post GL-only; the aggregate count was the only
    // clue and the vendor's whole year vanished from the 1099-NEC totals.
    const { tx } = makeStubTx({
      accounts: chartRows,
      vendors: [{ id: VENDOR_ID, name: 'J Smith Concrete' }],
      journalEntries: [],
    });
    const mk = (rowNumber: number, qbType: string, name: string, amount: string) => ({
      rowNumber,
      qbType,
      sourceType: 'bank_transaction' as const,
      posts: true,
      date: '2026-05-01',
      lines: [
        { account: 'Checking', amount: `-${amount}`, name },
        { account: 'Office Expense', amount },
      ],
    });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [
        mk(2, 'CHECK', 'J. Smith Concrete', '800.0000'),
        mk(6, 'CHECK', 'J. Smith Concrete', '400.0000'),
        // PAYCHECK payees are employees, never in the vendors table.
        mk(10, 'PAYCHECK', 'Maria Lopez', '2500.0000'),
      ],
    });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.posted).toBe(3);
    expect(result.paymentsLinked).toBe(0);
    expect(result.unlinkedPayees).toEqual([
      { name: 'J. Smith Concrete', count: 2, total: '1200.0000' },
      { name: 'Maria Lopez', count: 1, total: '2500.0000' },
    ]);
  });

  it('reports no unlinked payees when every money movement links', async () => {
    const { tx } = makeStubTx({
      accounts: chartRows,
      vendors: [{ id: VENDOR_ID, name: 'Joe Subcontractor' }],
      journalEntries: [],
    });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [
        {
          rowNumber: 5,
          qbType: 'CHECK',
          sourceType: 'bank_transaction',
          posts: true,
          date: '2026-05-01',
          lines: [
            { account: 'Checking', amount: '-2500.0000', name: 'Joe Subcontractor' },
            { account: 'Office Expense', amount: '2500.0000' },
          ],
        },
      ],
    });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.paymentsLinked).toBe(1);
    expect(result.unlinkedPayees).toEqual([]);
  });
});

describe('upload decoding (web decodeIifBuffer)', () => {
  const t = '\t';
  const iif = [
    `!ACCNT${t}NAME${t}ACCNTTYPE`,
    `ACCNT${t}Checking${t}BANK`,
    `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
    `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
    `!ENDTRNS`,
    `TRNS${t}CHECK${t}2026-02-01${t}Checking${t}-75.00`,
    `SPL${t}CHECK${t}2026-02-01${t}Office Expense${t}75.00`,
    `ENDTRNS`,
    ``,
  ].join('\r\n');

  function asciiBytes(s: string): ArrayBuffer {
    const buf = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i) & 0xff;
    return buf.buffer as ArrayBuffer;
  }

  function utf16Bytes(s: string, littleEndian: boolean, bom = true): ArrayBuffer {
    const head = bom ? 2 : 0;
    const buf = new Uint8Array(head + s.length * 2);
    if (bom) {
      buf[0] = littleEndian ? 0xff : 0xfe;
      buf[1] = littleEndian ? 0xfe : 0xff;
    }
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      buf[head + 2 * i] = littleEndian ? code & 0xff : code >> 8;
      buf[head + 2 * i + 1] = littleEndian ? code >> 8 : code & 0xff;
    }
    return buf.buffer as ArrayBuffer;
  }

  it('decodes an Excel "Unicode Text" (UTF-16LE with BOM) re-save instead of parsing an empty preview', () => {
    // Decoded as windows-1252 this became NUL-interleaved garbage: zero
    // accounts, zero transactions, zero warnings, and an enabled Confirm.
    const decoded = decodeIifBuffer(utf16Bytes(iif, true));
    expect('text' in decoded).toBe(true);
    const out = parseIif((decoded as { text: string }).text);
    expect(out.accounts).toHaveLength(1);
    expect(out.transactions).toHaveLength(1);
  });

  it('decodes UTF-16BE with BOM too', () => {
    const decoded = decodeIifBuffer(utf16Bytes(iif, false));
    expect('text' in decoded).toBe(true);
    const out = parseIif((decoded as { text: string }).text);
    expect(out.accounts).toHaveLength(1);
  });

  it('still decodes windows-1252 high bytes (curly quotes) via the fallback', () => {
    // Byte 0x92 is invalid UTF-8, so the strict pass must fail over to the
    // windows-1252 decoder without throwing or NUL-scrambling. (Browsers map
    // 0x92 -> U+2019 per the WHATWG standard; Node builds without full ICU
    // may pass it through as U+0092, so assert the surrounding structure
    // rather than the exact code point.)
    const decoded = decodeIifBuffer(
      asciiBytes(`!VEND${t}NAME\r\nVEND${t}Joe${String.fromCharCode(0x92)}s Diner\r\n`),
    );
    expect('text' in decoded).toBe(true);
    expect((decoded as { text: string }).text).toMatch(/VEND\tJoe.s Diner/);
  });

  it('rejects BOM-less UTF-16 with an explanation instead of a silent all-zero preview', () => {
    const decoded = decodeIifBuffer(utf16Bytes(iif, true, false));
    expect('error' in decoded).toBe(true);
    expect((decoded as { error: string }).error).toMatch(/UTF-16/);
  });

  it('plain UTF-8 still round-trips', () => {
    // .slice() guarantees the backing buffer is exactly the encoded bytes.
    const decoded = decodeIifBuffer(new TextEncoder().encode(iif).slice().buffer as ArrayBuffer);
    expect('text' in decoded).toBe(true);
    expect(parseIif((decoded as { text: string }).text).accounts).toHaveLength(1);
  });
});

describe("preview per-type 'Maps to' label (web mapsToLabel)", () => {
  it('labels posting and non-posting types from the sample transaction', () => {
    expect(mapsToLabel({ posts: true, sourceType: 'bank_transaction' }, 0)).toBe(
      'journal_entry (bank_transaction)',
    );
    expect(mapsToLabel({ posts: false, sourceType: 'import' }, 0)).toBe('skipped (non-posting)');
  });

  it("labels a type whose every block was excluded for data errors as excluded, NOT 'non-posting'", () => {
    // An unbalanced CHECK is a data error the user must fix; labelling it
    // "skipped (non-posting)" reads like an intentionally excluded document
    // class (estimates) and buries the problem.
    expect(mapsToLabel(undefined, 1)).toBe('excluded — data error (see warnings)');
    expect(mapsToLabel(undefined, 0)).toBe('skipped (non-posting)');
  });

  it('derives the label correctly from a real parse with one unbalanced CHECK and one good DEPOSIT', () => {
    const t = '\t';
    const preview = parseIif(
      [
        `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
        `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
        `!ENDTRNS`,
        `TRNS${t}CHECK${t}2026-01-10${t}Checking${t}-1234.56`,
        `SPL${t}CHECK${t}2026-01-10${t}Office Expense${t}1234.54`,
        `ENDTRNS`,
        `TRNS${t}DEPOSIT${t}2026-01-11${t}Checking${t}50.00`,
        `SPL${t}DEPOSIT${t}2026-01-11${t}Sales${t}-50.00`,
        `ENDTRNS`,
      ].join('\n'),
    );
    // Exactly what Imports.tsx renders per type row.
    const labelFor = (qbType: string) =>
      mapsToLabel(
        preview.transactions.find((x) => x.qbType === qbType),
        preview.excludedTransactions.filter((e) => e.qbType === qbType).length,
      );
    expect(labelFor('CHECK')).toBe('excluded — data error (see warnings)');
    expect(labelFor('DEPOSIT')).toBe('journal_entry (bank_transaction)');
  });
});

describe('commitIifImport hierarchy', () => {
  it('links colon-path sub-accounts to their parent account', async () => {
    const { tx, updated } = makeStubTx({ accounts: [] });
    const input = CommitIifSchema.parse({
      accounts: [
        { name: 'Utilities', type: 'expense', subtype: 'expense', code: '5010' },
        { name: 'Utilities:Gas & Electric', type: 'expense', subtype: 'expense', code: '5020' },
        { name: 'Utilities:Water', type: 'expense', subtype: 'expense', code: '5030' },
      ],
    });
    const result = await commitIifImport(tx, ctx, input);
    expect(result.accountsCreated).toBe(3);
    const patches = updated.get(accountsTable) ?? [];
    expect(patches).toHaveLength(2);
    // The stub hands out sequential ids; 'Utilities' was the first insert.
    for (const p of patches) {
      expect(p.parentId).toBe('e0000000-0000-4000-8000-000000000001');
    }
  });

  it('warns when a sub-account has no importable parent', async () => {
    const { tx, updated } = makeStubTx({ accounts: [] });
    const input = CommitIifSchema.parse({
      accounts: [
        { name: 'Payroll Expenses:Wages', type: 'expense', subtype: 'expense', code: '5040' },
      ],
    });
    const result = await commitIifImport(tx, ctx, input);
    expect(result.accountsCreated).toBe(1);
    expect(updated.get(accountsTable)).toBeUndefined();
    expect(
      result.warnings.some((w) => /Payroll Expenses:Wages/.test(w) && /parent/.test(w)),
    ).toBe(true);
  });

  it('discloses customer:job flattening in the commit warnings', async () => {
    const { tx } = makeStubTx({ customers: [] });
    const input = CommitIifSchema.parse({
      customers: [
        { displayName: 'Smith Construction' },
        { displayName: 'Smith Construction:Kitchen remodel' },
      ],
    });
    const result = await commitIifImport(tx, ctx, input);
    expect(result.customersCreated).toBe(2);
    expect(result.warnings.some((w) => /customer:job/.test(w) && /not preserved/.test(w))).toBe(
      true,
    );
  });
});

describe('preview size cap', () => {
  it('accepts a multi-year export bigger than the old 5 MB cap', () => {
    const parsed = PreviewBody.safeParse({ text: 'x'.repeat(7_500_000) });
    expect(parsed.success).toBe(true);
  });

  it('rejects >12MB with chunked-export guidance instead of a bare size error', () => {
    const parsed = PreviewBody.safeParse({ text: 'x'.repeat(12_000_001) });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/date-range chunks/);
      expect(parsed.error.issues[0]?.message).toMatch(/duplicates/);
      // The safety promise is qualified: an edited transaction is NOT a
      // duplicate and posts again -- the message must not oversell.
      expect(parsed.error.issues[0]?.message).toMatch(/edited in QuickBooks/);
    }
  });
});

describe('commitIifTransactions duplicate payment backfill', () => {
  const VENDOR_ID = 'b0000000-0000-4000-8000-000000000001';
  const PRIOR_ENTRY_ID = 'e1111111-0000-4000-8000-000000000001';
  const chartRows: Row[] = [
    { id: CHECKING_ID, name: 'Checking', isActive: true, companyId: ctx.companyId, currency: 'USD' },
    { id: EXPENSE_ID, name: 'Office Expense', isActive: true, companyId: ctx.companyId, currency: 'USD' },
  ];
  const priorLedger = {
    journalEntries: [
      { id: PRIOR_ENTRY_ID, entryDate: '2026-05-01', memo: null, reference: null },
    ] as Row[],
    journalLines: [
      { entryId: PRIOR_ENTRY_ID, accountId: CHECKING_ID, debit: '0', credit: '2500.0000' },
      { entryId: PRIOR_ENTRY_ID, accountId: EXPENSE_ID, debit: '2500.0000', credit: '0' },
    ] as Row[],
  };
  const joeCheck = {
    rowNumber: 5,
    qbType: 'CHECK',
    sourceType: 'bank_transaction' as const,
    posts: true,
    date: '2026-05-01',
    lines: [
      { account: 'Checking', amount: '-2500.0000', name: "Joe's Concrete" },
      { account: 'Office Expense', amount: '2500.0000' },
    ],
  };

  it('backfills the payments row when a duplicate now matches a vendor (fix-and-re-import remediation)', async () => {
    // Run 1 posted this check GL-only (no vendor existed); the user then
    // created the vendor and re-imported the same file. The duplicate skip
    // must write the missing payments row against the ORIGINAL entry --
    // silently no-opping left 1099-NEC totals short with no signal left.
    const { tx, inserted } = makeStubTx({
      accounts: chartRows,
      vendors: [{ id: VENDOR_ID, name: "Joe's Concrete" }],
      ...priorLedger,
    });
    const input = CommitIifTransactionsSchema.parse({ transactions: [joeCheck] });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.duplicates).toBe(1);
    expect(result.posted).toBe(0);
    expect(result.paymentsBackfilled).toBe(1);
    expect(result.errors).toEqual([]);
    expect(inserted.get(journalEntries)).toBeUndefined(); // nothing re-posted
    const payRows = inserted.get(paymentsTable)!;
    expect(payRows).toHaveLength(1);
    expect(payRows[0]).toMatchObject({
      paymentType: 'vendor_sent',
      vendorId: VENDOR_ID,
      amount: '2500.0000',
      bankAccountId: CHECKING_ID,
      postedJournalEntryId: PRIOR_ENTRY_ID,
      status: 'posted',
    });
    // The gap is repaired, so the payee no longer reads as unlinked.
    expect(result.unlinkedPayees).toEqual([]);
  });

  it('keeps disclosing still-unlinked duplicates instead of reading as fixed', async () => {
    // Same re-import but the vendor STILL doesn't exist: "1 duplicate
    // skipped" alone reads healthy while the 1099 shortfall persists.
    const { tx, inserted } = makeStubTx({ accounts: chartRows, ...priorLedger });
    const input = CommitIifTransactionsSchema.parse({ transactions: [joeCheck] });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.duplicates).toBe(1);
    expect(result.paymentsBackfilled).toBe(0);
    expect(inserted.get(paymentsTable)).toBeUndefined();
    expect(result.unlinkedPayees).toEqual([
      { name: "Joe's Concrete", count: 1, total: '2500.0000' },
    ]);
  });

  it('does not write a second payments row when the duplicate is already linked', async () => {
    const { tx, inserted } = makeStubTx({
      accounts: chartRows,
      vendors: [{ id: VENDOR_ID, name: "Joe's Concrete" }],
      ...priorLedger,
      payments: [{ entryId: PRIOR_ENTRY_ID }],
    });
    const input = CommitIifTransactionsSchema.parse({ transactions: [joeCheck] });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.duplicates).toBe(1);
    expect(result.paymentsBackfilled).toBe(0);
    expect(inserted.get(paymentsTable)).toBeUndefined();
    expect(result.unlinkedPayees).toEqual([]);
  });
});

describe('commitIifTransactions edited-transaction disclosure', () => {
  const chartRows: Row[] = [
    { id: CHECKING_ID, name: 'Checking', isActive: true, companyId: ctx.companyId, currency: 'USD' },
    { id: EXPENSE_ID, name: 'Office Expense', isActive: true, companyId: ctx.companyId, currency: 'USD' },
  ];
  const prior1250 = {
    journalEntries: [
      {
        id: 'e1111111-0000-4000-8000-000000000002',
        entryDate: '2026-05-01',
        memo: null,
        reference: '1044',
      },
    ] as Row[],
    journalLines: [
      {
        entryId: 'e1111111-0000-4000-8000-000000000002',
        accountId: CHECKING_ID,
        debit: '0',
        credit: '1250.0000',
      },
      {
        entryId: 'e1111111-0000-4000-8000-000000000002',
        accountId: EXPENSE_ID,
        debit: '1250.0000',
        credit: '0',
      },
    ] as Row[],
  };
  const check = (amount: string) => ({
    rowNumber: 5,
    qbType: 'CHECK',
    sourceType: 'bank_transaction' as const,
    posts: true,
    date: '2026-05-01',
    docNum: '1044',
    reference: '1044',
    lines: [
      { account: 'Checking', amount: `-${amount}` },
      { account: 'Office Expense', amount },
    ],
  });

  it('warns when a posted block shares date+reference with an existing entry but differs in content', async () => {
    // The $1,250 check was corrected to $1,520 in QBD and the year was
    // re-exported. The content fingerprint cannot call this a duplicate, so
    // both versions end up on the ledger -- the warning is the only trace.
    const { tx } = makeStubTx({ accounts: chartRows, ...prior1250 });
    const input = CommitIifTransactionsSchema.parse({ transactions: [check('1520.0000')] });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.posted).toBe(1);
    expect(result.duplicates).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/ref "1044"/);
    expect(result.warnings[0]).toMatch(/edited in QuickBooks/);
  });

  it('does not warn on a byte-identical re-import (true duplicate consumes its date+reference)', async () => {
    const { tx } = makeStubTx({ accounts: chartRows, ...prior1250 });
    const input = CommitIifTransactionsSchema.parse({ transactions: [check('1250.0000')] });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.duplicates).toBe(1);
    expect(result.posted).toBe(0);
    expect(result.warnings).toEqual([]);
  });
});

describe('commitIifTransactions case-twin account names', () => {
  const ASSET_TWIN_ID = 'a0000000-0000-4000-8000-000000000011';
  const EXPENSE_TWIN_ID = 'a0000000-0000-4000-8000-000000000012';
  const twinChart = (order: 'asset-first' | 'expense-first'): Row[] => {
    const twins = [
      { id: ASSET_TWIN_ID, name: 'INSURANCE', isActive: true, companyId: ctx.companyId, currency: 'USD' },
      { id: EXPENSE_TWIN_ID, name: 'Insurance', isActive: true, companyId: ctx.companyId, currency: 'USD' },
    ];
    if (order === 'expense-first') twins.reverse();
    return [
      { id: CHECKING_ID, name: 'Checking', isActive: true, companyId: ctx.companyId, currency: 'USD' },
      ...twins,
    ];
  };
  const insuranceCheck = (account: string) => ({
    rowNumber: 3,
    qbType: 'CHECK',
    sourceType: 'bank_transaction' as const,
    posts: true,
    date: '2026-06-01',
    lines: [
      { account: 'Checking', amount: '-400.0000' },
      { account, amount: '400.0000' },
    ],
  });

  it('resolves to the exact-cased twin regardless of chart scan order', async () => {
    // The old single Map was last-write-wins off an unordered SELECT --
    // reversing row order flipped which twin every line posted to.
    for (const order of ['asset-first', 'expense-first'] as const) {
      const { tx, inserted } = makeStubTx({
        accounts: twinChart(order),
        journalEntries: [],
      });
      const input = CommitIifTransactionsSchema.parse({
        transactions: [insuranceCheck('Insurance')],
      });
      const result = await commitIifTransactions(tx, ctx, input);
      expect(result.posted, order).toBe(1);
      expect(result.errors, order).toEqual([]);
      const lineAccounts = inserted.get(journalLines)!.map((l) => l.accountId);
      expect(lineAccounts, order).toContain(EXPENSE_TWIN_ID);
      expect(lineAccounts, order).not.toContain(ASSET_TWIN_ID);
    }
  });

  it('fails per-row instead of guessing when no exact-cased twin matches', async () => {
    const { tx, inserted } = makeStubTx({
      accounts: twinChart('asset-first'),
      journalEntries: [],
    });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [insuranceCheck('insurance')],
    });
    const result = await commitIifTransactions(tx, ctx, input);
    expect(result.posted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors[0]?.reason).toMatch(/differ\s+only by letter case/);
    expect(inserted.get(journalEntries)).toBeUndefined();
  });
});

describe('preview disclosure of DB-inactive accounts (two-file migration)', () => {
  const t = '\t';
  const transactionsOnlyFile = [
    `!TRNS${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
    `!SPL${t}TRNSTYPE${t}DATE${t}ACCNT${t}AMOUNT`,
    `!ENDTRNS`,
    `TRNS${t}CHECK${t}2019-06-01${t}Old First National${t}-75.00`,
    `SPL${t}CHECK${t}2019-06-01${t}Office Expense${t}75.00`,
    `ENDTRNS`,
    `TRNS${t}DEPOSIT${t}2019-07-01${t}Old First National${t}200.00`,
    `SPL${t}DEPOSIT${t}2019-07-01${t}Sales${t}-200.00`,
    `ENDTRNS`,
  ].join('\n');

  it('warns when transactions reference an account that exists in the DB but is inactive', () => {
    // The standard migration is two files: the lists IIF (which creates
    // HIDDEN=Y accounts as inactive), then the transactions IIF. For the
    // second file the account EXISTS, so missingAccounts is empty and the
    // in-file HIDDEN warning never fires -- the preview read clean while
    // every historical block died per-row at commit.
    const preview = parseIif(transactionsOnlyFile);
    const existing = new Set(['Old First National', 'Office Expense', 'Sales']);
    preview.missingAccounts = buildMissingAccounts(preview, existing);
    expect(preview.missingAccounts).toEqual([]);
    warnInactiveAccountRefs(preview, new Set(['Old First National']));
    const warning = preview.warnings.find((w) => /inactive/.test(w));
    expect(warning).toBeTruthy();
    expect(warning).toMatch(/2 transaction\(s\)/);
    expect(warning).toMatch(/"Old First National"/);
    expect(warning).toMatch(/re-activate/i);
  });

  it('stays silent when the referenced accounts are active', () => {
    const preview = parseIif(transactionsOnlyFile);
    warnInactiveAccountRefs(preview, new Set(['Some Other Closed Account']));
    expect(preview.warnings).toEqual([]);
  });

  it('does not duplicate the in-file HIDDEN warning when the same file defines the account as hidden', () => {
    const fileWithHiddenAccnt = [
      `!ACCNT${t}NAME${t}ACCNTTYPE${t}HIDDEN`,
      `ACCNT${t}Old First National${t}BANK${t}Y`,
      transactionsOnlyFile,
    ].join('\n');
    const preview = parseIif(fileWithHiddenAccnt);
    // parseIif already warned about the in-file HIDDEN reference.
    expect(preview.warnings.filter((w) => /HIDDEN=Y/.test(w))).toHaveLength(1);
    warnInactiveAccountRefs(preview, new Set(['Old First National']));
    // No second warning for the same account.
    expect(preview.warnings.filter((w) => /inactive/.test(w))).toHaveLength(1);
  });
});

describe('client chunking of the transactions commit (web iif-commit)', () => {
  const mkTxn = (n: number, amount = `${n}.0000`) => ({
    rowNumber: n,
    date: '2026-01-15',
    reference: `CHK-${n}`,
    memo: undefined,
    lines: [
      { account: 'Checking', amount: `-${amount}` },
      { account: 'Office Expense', amount },
    ],
  });

  it('bounds chunk sizes so no single request can run past the 60s platform caps', () => {
    const txns = Array.from({ length: 1201 }, (_, i) => mkTxn(i + 1));
    const chunks = chunkTransactionsForCommit(txns, 500);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 201]);
    // Nothing lost or duplicated across chunks.
    const flat = chunks.flat();
    expect(flat).toHaveLength(1201);
    expect(new Set(flat.map((x) => x.rowNumber)).size).toBe(1201);
  });

  it('keeps identical blocks in ONE chunk so the server-side multiset dedupe stays correct', () => {
    // Two legitimately identical checks (same date, ref, memo, lines) split
    // across two requests would make the second request's pre-scan see the
    // first's copy as a prior duplicate and silently drop a real
    // transaction. rowNumber differs but is not part of the identity.
    const twinA = { ...mkTxn(1, '75.0000'), reference: 'CHK-1' };
    const twinB = { ...mkTxn(4, '75.0000'), reference: 'CHK-1' };
    const txns = [twinA, mkTxn(2), mkTxn(3), twinB, mkTxn(5), mkTxn(6)];
    const chunks = chunkTransactionsForCommit(txns, 2);
    const chunkOf = (rowNumber: number) =>
      chunks.findIndex((c) => c.some((x) => x.rowNumber === rowNumber));
    expect(chunkOf(1)).toBe(chunkOf(4));
    expect(chunks.flat()).toHaveLength(6);
  });

  it('merges per-chunk results: counters sum, payees re-aggregate with exact decimal totals', () => {
    const merged = mergeTransactionCommitResults([
      {
        posted: 2,
        skipped: 1,
        duplicates: 0,
        voided: 1,
        paymentsLinked: 1,
        paymentsBackfilled: 0,
        unlinkedPayees: [{ name: "Joe's Concrete", count: 2, total: '800.0100' }],
        warnings: ['note A'],
        errors: [{ rowNumber: 4, qbType: 'CHECK', reason: 'x' }],
      },
      {
        posted: 3,
        skipped: 0,
        duplicates: 5,
        voided: 0,
        paymentsLinked: 0,
        paymentsBackfilled: 2,
        unlinkedPayees: [{ name: "JOE'S CONCRETE", count: 1, total: '199.9900' }],
        warnings: [],
        errors: [],
      },
    ]);
    expect(merged.posted).toBe(5);
    expect(merged.skipped).toBe(1);
    expect(merged.duplicates).toBe(5);
    expect(merged.voided).toBe(1);
    expect(merged.paymentsLinked).toBe(1);
    expect(merged.paymentsBackfilled).toBe(2);
    // Case-insensitive payee aggregation, exact 4dp arithmetic (no floats).
    expect(merged.unlinkedPayees).toEqual([
      { name: "Joe's Concrete", count: 3, total: '1000.0000' },
    ]);
    expect(merged.warnings).toEqual(['note A']);
    expect(merged.errors).toHaveLength(1);
  });
});

describe('commitIifTransactions rename-proof duplicate detection', () => {
  // The customer's file says "Chase Cheking" (a QBD typo). Between imports
  // the user renames the account in KPBooks to "Chase Checking", so on
  // re-import the file's old name re-resolves to a freshly auto-created
  // account with a NEW id -- the accountId fingerprint can never match and
  // every block used to re-post, doubling the ledger with zero disclosure
  // (no reference means not even the edited-in-QBD warning fired).
  const TYPO_ID = 'a0000000-0000-4000-8000-000000000021';
  const RECREATED_ID = 'a0000000-0000-4000-8000-000000000022';
  const PRIOR_ENTRY_ID = 'e1111111-0000-4000-8000-000000000009';
  const typoCheck = {
    rowNumber: 4,
    qbType: 'CHECK',
    sourceType: 'bank_transaction' as const,
    posts: true,
    date: '2026-05-01',
    // Deliberately no docNum/reference: the silent double-book case.
    lines: [
      { account: 'Chase Cheking', amount: '-75.0000' },
      { account: 'Office Expense', amount: '75.0000' },
    ],
  };
  const run1Chart: Row[] = [
    { id: TYPO_ID, name: 'Chase Cheking', isActive: true, companyId: ctx.companyId, currency: 'USD' },
    { id: EXPENSE_ID, name: 'Office Expense', isActive: true, companyId: ctx.companyId, currency: 'USD' },
  ];
  // After the rename + re-confirmed preview: the renamed account keeps the
  // original id, the typo name exists again under a NEW id.
  const run2Chart: Row[] = [
    { id: TYPO_ID, name: 'Chase Checking', isActive: true, companyId: ctx.companyId, currency: 'USD' },
    { id: RECREATED_ID, name: 'Chase Cheking', isActive: true, companyId: ctx.companyId, currency: 'USD' },
    { id: EXPENSE_ID, name: 'Office Expense', isActive: true, companyId: ctx.companyId, currency: 'USD' },
  ];
  const priorLines: Row[] = [
    { entryId: PRIOR_ENTRY_ID, accountId: TYPO_ID, debit: '0', credit: '75.0000' },
    { entryId: PRIOR_ENTRY_ID, accountId: EXPENSE_ID, debit: '75.0000', credit: '0' },
  ];

  async function postOnceAndCaptureSourceId(): Promise<string> {
    const run1 = makeStubTx({ accounts: run1Chart, journalEntries: [] });
    const input = CommitIifTransactionsSchema.parse({ transactions: [typoCheck] });
    const result = await commitIifTransactions(run1.tx, ctx, input);
    expect(result.posted).toBe(1);
    const entry = run1.inserted.get(journalEntries)![0]!;
    return String(entry.sourceId);
  }

  it('stamps a deterministic file-content source_id on every posted entry', async () => {
    const first = await postOnceAndCaptureSourceId();
    const second = await postOnceAndCaptureSourceId();
    // A valid uuid (fits journal_entries.source_id) and stable across runs
    // -- that stability is what ties a re-imported block back to the file.
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toBe(first);
  });

  it('skips the re-imported block as a duplicate even after the account was renamed and re-created', async () => {
    const stampedSourceId = await postOnceAndCaptureSourceId();
    const run2 = makeStubTx({
      accounts: run2Chart,
      journalEntries: [
        {
          id: PRIOR_ENTRY_ID,
          entryDate: '2026-05-01',
          memo: null,
          reference: null,
          sourceId: stampedSourceId,
        },
      ],
      journalLines: priorLines,
    });
    const input = CommitIifTransactionsSchema.parse({ transactions: [typoCheck] });
    const result = await commitIifTransactions(run2.tx, ctx, input);
    expect(result.duplicates).toBe(1);
    expect(result.posted).toBe(0);
    expect(result.errors).toEqual([]);
    expect(run2.inserted.get(journalEntries)).toBeUndefined(); // nothing double-booked
  });

  it('keeps multiset semantics: two identical blocks against ONE stamped prior copy skip exactly once', async () => {
    // A file can legitimately contain N identical blocks; the rename-proof
    // path must not over-consume and silently drop the (N - priors) that
    // still need to post.
    const stampedSourceId = await postOnceAndCaptureSourceId();
    const run2 = makeStubTx({
      accounts: run2Chart,
      journalEntries: [
        {
          id: PRIOR_ENTRY_ID,
          entryDate: '2026-05-01',
          memo: null,
          reference: null,
          sourceId: stampedSourceId,
        },
      ],
      journalLines: priorLines,
    });
    const input = CommitIifTransactionsSchema.parse({
      transactions: [typoCheck, { ...typoCheck, rowNumber: 8 }],
    });
    const result = await commitIifTransactions(run2.tx, ctx, input);
    expect(result.duplicates).toBe(1);
    expect(result.posted).toBe(1);
    expect(run2.inserted.get(journalEntries)).toHaveLength(1);
  });

  it('legacy entries without a stamp still dedupe via the accountId fingerprint', async () => {
    // Entries imported before the stamp existed carry sourceId null; the
    // original fingerprint path must keep protecting plain re-imports.
    const run2 = makeStubTx({
      accounts: run1Chart,
      journalEntries: [
        { id: PRIOR_ENTRY_ID, entryDate: '2026-05-01', memo: null, reference: null, sourceId: null },
      ],
      journalLines: priorLines,
    });
    const input = CommitIifTransactionsSchema.parse({ transactions: [typoCheck] });
    const result = await commitIifTransactions(run2.tx, ctx, input);
    expect(result.duplicates).toBe(1);
    expect(result.posted).toBe(0);
  });
});

describe('commitIifImport type disagreement on name conflict', () => {
  it("warns when a skipped row's ACCNTTYPE mapping differs from the stored account's type", async () => {
    // Reversed two-file order: the transactions IIF imported first
    // auto-created this account with a heuristic guess (expense); the lists
    // IIF now arrives with the real ACCNTTYPE. The row must still skip
    // (names are identity) but the disagreement must be disclosed, or the
    // chart keeps the wrong classification with only "already exists" noise.
    const { tx, inserted } = makeStubTx({
      accounts: [
        {
          id: 'a0000000-0000-4000-8000-000000000031',
          code: '5015',
          name: 'Customer Deposits Held',
          type: 'expense',
          subtype: 'expense',
        },
      ],
    });
    const input = CommitIifSchema.parse({
      accounts: [
        {
          name: 'Customer Deposits Held',
          type: 'liability',
          subtype: 'other_current_liability',
          code: '2050',
        },
      ],
    });
    const result = await commitIifImport(tx, ctx, input);
    expect(result.accountsSkipped).toBe(1);
    expect(result.conflicts[0]?.reason).toBe('name already exists');
    expect(inserted.get(accountsTable)).toBeUndefined();
    const warning = result.warnings.find((w) => /Customer Deposits Held/.test(w));
    expect(warning).toBeTruthy();
    expect(warning).toMatch(/liability\/other_current_liability/);
    expect(warning).toMatch(/expense\/expense/);
    expect(warning).toMatch(/existing type was kept/);
  });

  it('stays quiet when the skipped row and the stored account agree on type', async () => {
    const { tx } = makeStubTx({
      accounts: [
        {
          id: 'a0000000-0000-4000-8000-000000000032',
          code: '1010',
          name: 'Checking',
          type: 'asset',
          subtype: 'bank',
        },
      ],
    });
    const input = CommitIifSchema.parse({
      accounts: [{ name: 'Checking', type: 'asset', subtype: 'bank', code: '1010' }],
    });
    const result = await commitIifImport(tx, ctx, input);
    expect(result.accountsSkipped).toBe(1);
    expect(result.warnings).toEqual([]);
  });
});

describe('client chunking of the lists commit (web iif-commit)', () => {
  const acct = (name: string) => ({ name, type: 'expense', subtype: 'expense', code: name });

  it('bounds lists request sizes across accounts + customers + vendors', () => {
    // The server awaits one INSERT per row inside a single transaction; one
    // unchunked request for a 12-year company file (thousands of customers/
    // vendors) ran past the 60s platform caps, rolled everything back, and
    // failed identically on every retry.
    const lists = {
      accounts: Array.from({ length: 300 }, (_, i) => acct(`Account ${i}`)),
      customers: Array.from({ length: 900 }, (_, i) => ({ displayName: `Customer ${i}` })),
      vendors: Array.from({ length: 150 }, (_, i) => ({ displayName: `Vendor ${i}` })),
    };
    const chunks = chunkListsForCommit(lists, 500);
    const sizes = chunks.map((c) => c.accounts.length + c.customers.length + c.vendors.length);
    expect(sizes).toEqual([500, 500, 350]);
    // Nothing lost or duplicated across chunks.
    expect(chunks.flatMap((c) => c.accounts)).toHaveLength(300);
    expect(chunks.flatMap((c) => c.customers)).toHaveLength(900);
    expect(chunks.flatMap((c) => c.vendors)).toHaveLength(150);
    expect(new Set(chunks.flatMap((c) => c.customers.map((x) => x.displayName))).size).toBe(900);
  });

  it('keeps colon-path account families in one chunk so per-request parent linking still works', () => {
    // The server links sub-account parent_id within a single request (plus
    // whatever is already in the DB). A parent split into a LATER chunk than
    // its child would leave the child unlinked.
    const accounts = [
      acct('Utilities'),
      ...Array.from({ length: 7 }, (_, i) => acct(`Filler ${i}`)),
      acct('Utilities:Gas & Electric'),
      acct('Utilities:Gas & Electric:Commercial'),
    ];
    const chunks = chunkListsForCommit({ accounts, customers: [], vendors: [] }, 3);
    const chunkOf = (name: string) =>
      chunks.findIndex((c) => c.accounts.some((a) => a.name === name));
    expect(chunkOf('Utilities')).toBeGreaterThanOrEqual(0);
    expect(chunkOf('Utilities:Gas & Electric')).toBe(chunkOf('Utilities'));
    expect(chunkOf('Utilities:Gas & Electric:Commercial')).toBe(chunkOf('Utilities'));
    expect(chunks.flatMap((c) => c.accounts)).toHaveLength(accounts.length);
  });

  it('emits one empty request for an all-empty commit (preserves the unchunked flow)', () => {
    expect(chunkListsForCommit({ accounts: [], customers: [], vendors: [] })).toEqual([
      { accounts: [], customers: [], vendors: [] },
    ]);
  });

  it('merges per-chunk lists results: counters sum, conflicts and warnings concatenate', () => {
    const merged = mergeListsCommitResults([
      {
        accountsCreated: 2,
        accountsSkipped: 1,
        customersCreated: 400,
        customersSkipped: 0,
        vendorsCreated: 0,
        vendorsSkipped: 0,
        conflicts: [{ kind: 'account', identifier: 'Checking', reason: 'name already exists' }],
        warnings: ['account "X": code 1010 already exists; assigned 1011 instead'],
      },
      {
        accountsCreated: 0,
        accountsSkipped: 0,
        customersCreated: 100,
        customersSkipped: 3,
        vendorsCreated: 150,
        vendorsSkipped: 2,
        conflicts: [{ kind: 'vendor', identifier: 'Acme', reason: 'name already exists' }],
        warnings: [],
      },
    ]);
    expect(merged.accountsCreated).toBe(2);
    expect(merged.accountsSkipped).toBe(1);
    expect(merged.customersCreated).toBe(500);
    expect(merged.customersSkipped).toBe(3);
    expect(merged.vendorsCreated).toBe(150);
    expect(merged.vendorsSkipped).toBe(2);
    expect(merged.conflicts).toHaveLength(2);
    expect(merged.warnings).toHaveLength(1);
  });
});

describe('commit company binding (web assertCommitCompanyUnchanged)', () => {
  // The commit endpoints scope purely by the x-kpbooks-company header and a
  // CPA is a member of many client companies, so a preview left open across
  // a company switch would commit Client A's entire books into Client B --
  // and mostly SUCCEED, because missing accounts auto-create. The component
  // resets on company change; this guard is the mutation-time backstop.
  it('throws when the active company changed between preview and Confirm', () => {
    expect(() =>
      assertCommitCompanyUnchanged(
        'c0000000-0000-4000-8000-000000000001',
        'c0000000-0000-4000-8000-000000000002',
      ),
    ).toThrow(/changed since this file was previewed/i);
  });

  it('throws when either side is missing instead of committing unscoped', () => {
    expect(() => assertCommitCompanyUnchanged(null, 'c0000000-0000-4000-8000-000000000001')).toThrow();
    expect(() => assertCommitCompanyUnchanged('c0000000-0000-4000-8000-000000000001', null)).toThrow();
    expect(() => assertCommitCompanyUnchanged(null, null)).toThrow();
  });

  it('passes when the company is unchanged', () => {
    expect(() =>
      assertCommitCompanyUnchanged(
        'c0000000-0000-4000-8000-000000000001',
        'c0000000-0000-4000-8000-000000000001',
      ),
    ).not.toThrow();
  });
});
