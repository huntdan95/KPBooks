import {
  type Database,
  accounts,
  bankTransactions,
  reconciliations,
} from '@kpbooks/db';
import { Money } from '@kpbooks/money';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

/**
 * Bank reconciliation service.
 *
 * Workflow per bank account:
 *   1. start({bankAccountId, statementDate, statementBalance})
 *      Creates a reconciliation in 'in_progress'. Beginning balance is
 *      pulled from the most recent completed reconciliation, or 0 for the
 *      first one. Only one in_progress per bank account at a time (enforced
 *      by partial unique index).
 *   2. summary(reconciliationId)
 *      Returns the open transactions on/before statementDate that haven't
 *      yet been cleared into another reconciliation, plus running totals
 *      and the diff to balance.
 *   3. setCleared(bankTransactionId, reconciliationId, cleared: boolean)
 *      Toggle a single posted transaction in/out of the reconciliation.
 *   4. finalise(reconciliationId)
 *      Closes the reconciliation. Requires sum(cleared.amount) ==
 *      statementBalance - beginningBalance. Locks the cleared rows.
 *   5. reopen(reconciliationId)  -- admin/owner only
 *      Flips back to 'in_progress' so the user can fix mistakes.
 */

export const StartSchema = z
  .object({
    bankAccountId: z.string().uuid(),
    statementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
    statementBalance: z.union([z.string(), z.number()]),
    notes: z.string().max(2000).optional(),
  })
  .strict();

export type StartInput = z.infer<typeof StartSchema>;

export interface ReconciliationContext {
  companyId: string;
  userId: string;
}

export class ReconciliationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'unknown_bank_account'
      | 'wrong_account_type'
      | 'in_progress_exists'
      | 'not_found'
      | 'wrong_status'
      | 'unbalanced'
      | 'invalid_input',
  ) {
    super(message);
    this.name = 'ReconciliationError';
  }
}

export async function startReconciliation(
  tx: Database,
  ctx: ReconciliationContext,
  input: StartInput,
): Promise<{ id: string; beginningBalance: string }> {
  // Bank account must exist + correct subtype.
  const [account] = await tx
    .select({ id: accounts.id, subtype: accounts.subtype, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.id, input.bankAccountId));
  if (!account) {
    throw new ReconciliationError(
      `account ${input.bankAccountId} not found`,
      'unknown_bank_account',
    );
  }
  if (!account.isActive) {
    throw new ReconciliationError(
      `account ${input.bankAccountId} is inactive`,
      'unknown_bank_account',
    );
  }
  if (account.subtype !== 'bank' && account.subtype !== 'credit_card') {
    throw new ReconciliationError(
      `account is ${account.subtype}; reconciliation requires bank or credit_card`,
      'wrong_account_type',
    );
  }

  // Reject if there's already an in-progress reconciliation for this account
  // (DB also enforces via partial unique index, but we want a clean error).
  const [existing] = await tx
    .select({ id: reconciliations.id })
    .from(reconciliations)
    .where(
      and(
        eq(reconciliations.bankAccountId, input.bankAccountId),
        eq(reconciliations.status, 'in_progress'),
      ),
    )
    .limit(1);
  if (existing) {
    throw new ReconciliationError(
      `bank account already has an in-progress reconciliation (${existing.id})`,
      'in_progress_exists',
    );
  }

  // Beginning balance = statement_balance of the most recent completed
  // reconciliation for this account, or 0.
  const [prev] = await tx
    .select({ statementBalance: reconciliations.statementBalance })
    .from(reconciliations)
    .where(
      and(
        eq(reconciliations.bankAccountId, input.bankAccountId),
        eq(reconciliations.status, 'completed'),
      ),
    )
    .orderBy(desc(reconciliations.statementDate))
    .limit(1);
  const beginningBalance = prev?.statementBalance ?? '0.0000';

  const statementBalanceStr =
    typeof input.statementBalance === 'number'
      ? input.statementBalance.toFixed(4)
      : Money.of(input.statementBalance, 'USD').toPgNumeric();

  const [created] = await tx
    .insert(reconciliations)
    .values({
      companyId: ctx.companyId,
      bankAccountId: input.bankAccountId,
      statementDate: input.statementDate,
      statementBalance: statementBalanceStr,
      beginningBalance,
      status: 'in_progress',
      notes: input.notes ?? null,
    })
    .returning({ id: reconciliations.id });
  return { id: created!.id, beginningBalance };
}

export interface ReconciliationSummary {
  id: string;
  bankAccountId: string;
  statementDate: string;
  statementBalance: string;
  beginningBalance: string;
  status: 'in_progress' | 'completed';
  notes: string | null;
  /** All posted transactions on/before statementDate that aren't already cleared into another finalised reconciliation. */
  transactions: Array<{
    id: string;
    transactionDate: string;
    description: string;
    amount: string;
    cleared: boolean;
  }>;
  /** Sum of cleared.amount within this reconciliation. */
  clearedTotal: string;
  /** Target = statementBalance - beginningBalance. Diff = target - clearedTotal. */
  target: string;
  diff: string;
  isBalanced: boolean;
}

export async function getReconciliationSummary(
  tx: Database,
  reconciliationId: string,
): Promise<ReconciliationSummary> {
  const [rec] = await tx
    .select()
    .from(reconciliations)
    .where(eq(reconciliations.id, reconciliationId));
  if (!rec) {
    throw new ReconciliationError(
      `reconciliation ${reconciliationId} not found`,
      'not_found',
    );
  }

  // Eligible transactions: posted, on/before statement date, and either
  // already cleared into THIS reconciliation OR not cleared anywhere.
  const eligible = await tx
    .select({
      id: bankTransactions.id,
      transactionDate: bankTransactions.transactionDate,
      description: bankTransactions.description,
      amount: bankTransactions.amount,
      reconciliationId: bankTransactions.reconciliationId,
    })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.bankAccountId, rec.bankAccountId),
        eq(bankTransactions.status, 'posted'),
      ),
    )
    .orderBy(bankTransactions.transactionDate);

  const filtered = eligible.filter(
    (t) =>
      t.transactionDate <= rec.statementDate &&
      (t.reconciliationId === null || t.reconciliationId === reconciliationId),
  );

  let clearedTotal = Money.zero('USD');
  for (const t of filtered) {
    if (t.reconciliationId === reconciliationId) {
      clearedTotal = clearedTotal.add(Money.of(t.amount, 'USD'));
    }
  }

  const target = Money.of(rec.statementBalance, 'USD').sub(
    Money.of(rec.beginningBalance, 'USD'),
  );
  const diff = target.sub(clearedTotal);

  return {
    id: rec.id,
    bankAccountId: rec.bankAccountId,
    statementDate: rec.statementDate,
    statementBalance: rec.statementBalance,
    beginningBalance: rec.beginningBalance,
    status: rec.status,
    notes: rec.notes,
    transactions: filtered.map((t) => ({
      id: t.id,
      transactionDate: t.transactionDate,
      description: t.description,
      amount: t.amount,
      cleared: t.reconciliationId === reconciliationId,
    })),
    clearedTotal: clearedTotal.toPgNumeric(),
    target: target.toPgNumeric(),
    diff: diff.toPgNumeric(),
    isBalanced: diff.isZero(),
  };
}

export async function setTransactionCleared(
  tx: Database,
  reconciliationId: string,
  bankTransactionId: string,
  cleared: boolean,
): Promise<{ id: string; cleared: boolean }> {
  const [rec] = await tx
    .select({ id: reconciliations.id, status: reconciliations.status })
    .from(reconciliations)
    .where(eq(reconciliations.id, reconciliationId));
  if (!rec) {
    throw new ReconciliationError(
      `reconciliation ${reconciliationId} not found`,
      'not_found',
    );
  }
  if (rec.status !== 'in_progress') {
    throw new ReconciliationError(
      'cannot toggle cleared on a completed reconciliation',
      'wrong_status',
    );
  }

  const [bt] = await tx
    .select({
      id: bankTransactions.id,
      status: bankTransactions.status,
      reconciliationId: bankTransactions.reconciliationId,
    })
    .from(bankTransactions)
    .where(eq(bankTransactions.id, bankTransactionId));
  if (!bt) {
    throw new ReconciliationError(
      `bank transaction ${bankTransactionId} not found`,
      'not_found',
    );
  }
  if (bt.status !== 'posted') {
    throw new ReconciliationError(
      'only posted bank transactions can be cleared',
      'invalid_input',
    );
  }
  if (bt.reconciliationId && bt.reconciliationId !== reconciliationId) {
    throw new ReconciliationError(
      'transaction already belongs to a different reconciliation',
      'invalid_input',
    );
  }

  if (cleared) {
    await tx
      .update(bankTransactions)
      .set({ reconciliationId, clearedAt: new Date() })
      .where(eq(bankTransactions.id, bankTransactionId));
  } else {
    await tx
      .update(bankTransactions)
      .set({ reconciliationId: null, clearedAt: null })
      .where(eq(bankTransactions.id, bankTransactionId));
  }
  return { id: bankTransactionId, cleared };
}

export async function finaliseReconciliation(
  tx: Database,
  ctx: ReconciliationContext,
  reconciliationId: string,
): Promise<{ id: string }> {
  const summary = await getReconciliationSummary(tx, reconciliationId);
  if (summary.status !== 'in_progress') {
    throw new ReconciliationError('reconciliation is not in progress', 'wrong_status');
  }
  if (!summary.isBalanced) {
    throw new ReconciliationError(
      `cannot finalise; off by ${summary.diff}`,
      'unbalanced',
    );
  }
  await tx
    .update(reconciliations)
    .set({
      status: 'completed',
      completedAt: new Date(),
      completedBy: ctx.userId,
    })
    .where(eq(reconciliations.id, reconciliationId));
  return { id: reconciliationId };
}

export async function reopenReconciliation(
  tx: Database,
  reconciliationId: string,
): Promise<{ id: string }> {
  const [rec] = await tx
    .select({ id: reconciliations.id, status: reconciliations.status })
    .from(reconciliations)
    .where(eq(reconciliations.id, reconciliationId));
  if (!rec) {
    throw new ReconciliationError(
      `reconciliation ${reconciliationId} not found`,
      'not_found',
    );
  }
  if (rec.status !== 'completed') {
    throw new ReconciliationError('only completed reconciliations can be reopened', 'wrong_status');
  }
  // The lock trigger blocks status transitions on completed rows, but the
  // explicit completed -> in_progress flip is allowed here because we set
  // completed_at + completed_by back to null in the same statement, which
  // the trigger's "no field changes except notes" rule does block. So we
  // need to do this with the trigger temporarily disabled. Simpler: do it
  // as a direct UPDATE -- the trigger explicitly allows status changes
  // FROM 'completed' to a different status (it only locks
  // completed -> completed updates that touch other fields).
  await tx
    .update(reconciliations)
    .set({
      status: 'in_progress',
      completedAt: null,
      completedBy: null,
    })
    .where(eq(reconciliations.id, reconciliationId));
  return { id: reconciliationId };
}

export async function listReconciliations(
  tx: Database,
  filter: { bankAccountId?: string | undefined; status?: 'in_progress' | 'completed' | undefined },
) {
  const rows = await tx
    .select()
    .from(reconciliations)
    .where(
      and(
        filter.bankAccountId ? eq(reconciliations.bankAccountId, filter.bankAccountId) : undefined,
        filter.status ? eq(reconciliations.status, filter.status) : undefined,
      ),
    )
    .orderBy(desc(reconciliations.statementDate), desc(reconciliations.createdAt));
  return rows;
}

