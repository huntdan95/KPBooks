import { type Database, accounts, journalEntries, journalLines } from '@kpbooks/db';
import { Money, type CurrencyCode, isBalanced } from '@kpbooks/money';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

/**
 * posting.service — the **only** code path that writes to journal_entries / journal_lines.
 *
 * Every economic event (invoice, bill, payment, payroll paycheck, manual JE, import row)
 * funnels through `postEntry`. That single entry point lets us guarantee:
 *   • All journal_entries have ≥ 2 lines.
 *   • All entries balance per currency (also enforced by the deferred DB trigger).
 *   • Source provenance is recorded so reversals + audit traces always have context.
 *   • Closed-period guard fires (DB trigger).
 *
 * This service NEVER mutates posted entries. To "edit", call `reverseEntry` and post a
 * replacement — that's how an audit trail survives.
 */

const MoneyAmountSchema = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === 'number' ? v.toString() : v));

const PostLineSchema = z
  .object({
    accountId: z.string().uuid(),
    debit: MoneyAmountSchema.optional(),
    credit: MoneyAmountSchema.optional(),
    currency: z.string().min(3).max(8).default('USD'),
    fxRate: MoneyAmountSchema.default('1'),
    memo: z.string().max(500).optional(),
    dimensionJson: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((l) => Boolean(l.debit) !== Boolean(l.credit), {
    message: 'each line must have exactly one of debit or credit',
  });

const PostEntrySchema = z.object({
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  sourceType: z.enum([
    'manual',
    'invoice',
    'bill',
    'payment',
    'bank_transaction',
    'reconciliation',
    'payroll',
    'import',
    'reversal',
  ]),
  sourceId: z.string().uuid().optional(),
  memo: z.string().max(500).optional(),
  reference: z.string().max(120).optional(),
  lines: z.array(PostLineSchema).min(2, 'at least two lines required'),
});

export type PostEntryInput = z.infer<typeof PostEntrySchema>;
export type PostLineInput = z.infer<typeof PostLineSchema>;

export interface PostEntryContext {
  companyId: string;
  userId: string;
}

export interface PostEntryResult {
  id: string;
  entryDate: string;
  sourceType: PostEntryInput['sourceType'];
  lineCount: number;
}

export class PostingError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'unbalanced'
      | 'unknown_account'
      | 'cross_company_account'
      | 'inactive_account'
      | 'currency_mixed'
      | 'invalid_input',
  ) {
    super(message);
    this.name = 'PostingError';
  }
}

export async function postEntry(
  tx: Database,
  ctx: PostEntryContext,
  input: PostEntryInput,
): Promise<PostEntryResult> {
  const parsed = PostEntrySchema.safeParse(input);
  if (!parsed.success) {
    throw new PostingError(parsed.error.issues.map((i) => i.message).join('; '), 'invalid_input');
  }
  const data = parsed.data;

  // Bucket lines by currency to reuse Money arithmetic and the isBalanced helper.
  const debitsByCcy = new Map<CurrencyCode, Money[]>();
  const creditsByCcy = new Map<CurrencyCode, Money[]>();
  for (const l of data.lines) {
    const ccy = l.currency;
    if (l.debit) {
      const m = Money.of(l.debit, ccy);
      if (!m.isPositive()) {
        throw new PostingError('debit must be > 0', 'invalid_input');
      }
      (debitsByCcy.get(ccy) ?? debitsByCcy.set(ccy, []).get(ccy)!).push(m);
    } else if (l.credit) {
      const m = Money.of(l.credit, ccy);
      if (!m.isPositive()) {
        throw new PostingError('credit must be > 0', 'invalid_input');
      }
      (creditsByCcy.get(ccy) ?? creditsByCcy.set(ccy, []).get(ccy)!).push(m);
    }
  }

  // App-level balance pre-check (the DB trigger is the final word at COMMIT).
  const allCurrencies = new Set<string>([...debitsByCcy.keys(), ...creditsByCcy.keys()]);
  for (const ccy of allCurrencies) {
    const d = debitsByCcy.get(ccy) ?? [];
    const c = creditsByCcy.get(ccy) ?? [];
    if (!isBalanced(d, c)) {
      const dt = d.reduce((acc, x) => acc.add(x), Money.zero(ccy));
      const ct = c.reduce((acc, x) => acc.add(x), Money.zero(ccy));
      throw new PostingError(
        `unbalanced in ${ccy}: debits=${dt.toDecimalString()} credits=${ct.toDecimalString()}`,
        'unbalanced',
      );
    }
  }

  // Resolve and validate accounts (RLS already constrains to current_company,
  // so fetching accounts.length < expected means at least one is foreign or unknown).
  const accountIds = Array.from(new Set(data.lines.map((l) => l.accountId)));
  const fetched = await tx
    .select({
      id: accounts.id,
      companyId: accounts.companyId,
      isActive: accounts.isActive,
      currency: accounts.currency,
    })
    .from(accounts)
    .where(inArray(accounts.id, accountIds));
  const accountMap = new Map(fetched.map((a) => [a.id, a]));
  for (const id of accountIds) {
    const a = accountMap.get(id);
    if (!a) throw new PostingError(`unknown account ${id}`, 'unknown_account');
    if (a.companyId !== ctx.companyId)
      throw new PostingError(`account ${id} belongs to another company`, 'cross_company_account');
    if (!a.isActive) throw new PostingError(`account ${id} is inactive`, 'inactive_account');
  }

  // Insert entry header.
  const [entry] = await tx
    .insert(journalEntries)
    .values({
      companyId: ctx.companyId,
      entryDate: data.entryDate,
      sourceType: data.sourceType,
      sourceId: data.sourceId ?? null,
      memo: data.memo ?? null,
      reference: data.reference ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: journalEntries.id });

  if (!entry) throw new PostingError('failed to insert journal entry', 'invalid_input');

  // Insert lines. Money.toPgNumeric() yields a NUMERIC-safe decimal string.
  await tx.insert(journalLines).values(
    data.lines.map((l) => ({
      entryId: entry.id,
      companyId: ctx.companyId,
      accountId: l.accountId,
      debit: l.debit ? Money.of(l.debit, l.currency).toPgNumeric() : '0',
      credit: l.credit ? Money.of(l.credit, l.currency).toPgNumeric() : '0',
      currency: l.currency,
      fxRate: l.fxRate,
      memo: l.memo ?? null,
      dimensionJson: l.dimensionJson ?? null,
    })),
  );

  return {
    id: entry.id,
    entryDate: data.entryDate,
    sourceType: data.sourceType,
    lineCount: data.lines.length,
  };
}

/**
 * Reverse an existing journal entry by emitting a mirror entry with debits/credits
 * swapped. The original is then locked. Use when an invoice is voided, a bank
 * transaction is rebooked, etc. The audit pair (original + reversal) is preserved.
 */
export async function reverseEntry(
  tx: Database,
  ctx: PostEntryContext,
  originalEntryId: string,
  opts: { entryDate: string; memo?: string },
): Promise<PostEntryResult> {
  const originals = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, originalEntryId));

  if (originals.length === 0) {
    throw new PostingError(`entry ${originalEntryId} not found`, 'invalid_input');
  }

  const reversal = await postEntry(tx, ctx, {
    entryDate: opts.entryDate,
    sourceType: 'reversal',
    sourceId: originalEntryId,
    memo: opts.memo ?? `reversal of ${originalEntryId}`,
    lines: originals.map((l) => ({
      accountId: l.accountId,
      debit: Number(l.credit) > 0 ? l.credit : undefined,
      credit: Number(l.debit) > 0 ? l.debit : undefined,
      currency: l.currency,
      fxRate: l.fxRate,
      memo: l.memo ?? undefined,
      dimensionJson: (l.dimensionJson as Record<string, unknown> | null) ?? undefined,
    })),
  });

  // Link + lock the original. The closed-period trigger does NOT fire on `locked`-only
  // updates because the locked-entry guard short-circuits before that.
  await tx
    .update(journalEntries)
    .set({ reversedBy: reversal.id, locked: true })
    .where(eq(journalEntries.id, originalEntryId));

  return reversal;
}

export const postingSchemas = { PostEntrySchema, PostLineSchema };
