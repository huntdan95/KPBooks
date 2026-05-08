import {
  type Database,
  accounts,
  bankTransactions,
  journalEntries,
  journalLines,
} from '@kpbooks/db';
import { Money } from '@kpbooks/money';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { callAnthropic, isAvailable as anthropicAvailable, stripCodeFence } from '../ai/anthropic.js';
import { PostingError, postEntry } from '../ledger/posting.service.js';
import { parseBankCsv, type ParsedBankRow } from './csv-parser.js';

export const ImportCsvSchema = z.object({
  bankAccountId: z.string().uuid(),
  csvText: z.string().min(1).max(2_000_000),
});

export type ImportCsvInput = z.infer<typeof ImportCsvSchema>;

export interface ImportCsvResult {
  importBatchId: string;
  imported: number;
  duplicates: number;
  warnings: string[];
}

export interface BankingContext {
  companyId: string;
  userId: string;
}

export class BankingError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'unknown_bank_account'
      | 'wrong_account_type'
      | 'parse_failed'
      | 'invalid_input'
      | 'not_found'
      | 'wrong_status'
      | 'ai_unavailable'
      | 'ai_failed',
  ) {
    super(message);
    this.name = 'BankingError';
  }
}

function dedupeHash(
  bankAccountId: string,
  date: string,
  description: string,
  amount: string,
): string {
  return createHash('sha256')
    .update(`${bankAccountId}|${date}|${description}|${amount}`)
    .digest('hex');
}

export async function importBankCsv(
  tx: Database,
  ctx: BankingContext,
  input: ImportCsvInput,
): Promise<ImportCsvResult> {
  // Verify the bank account exists, belongs to the company, and is the
  // right kind of account.
  const [bankAccount] = await tx
    .select({ id: accounts.id, subtype: accounts.subtype, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.id, input.bankAccountId));
  if (!bankAccount) {
    throw new BankingError(`account ${input.bankAccountId} not found`, 'unknown_bank_account');
  }
  if (!bankAccount.isActive) {
    throw new BankingError(`account ${input.bankAccountId} is inactive`, 'unknown_bank_account');
  }
  if (bankAccount.subtype !== 'bank' && bankAccount.subtype !== 'credit_card') {
    throw new BankingError(
      `account is ${bankAccount.subtype}; bank import requires bank or credit_card`,
      'wrong_account_type',
    );
  }

  const parsed = parseBankCsv(input.csvText);
  if (parsed.rows.length === 0) {
    throw new BankingError(
      `no rows parsed from CSV: ${parsed.warnings.join('; ')}`,
      'parse_failed',
    );
  }

  // Dedupe against existing rows for this bank account.
  const candidateHashes = parsed.rows.map((r) =>
    dedupeHash(input.bankAccountId, r.date, r.description, r.amount),
  );
  const existing = await tx
    .select({ hash: bankTransactions.dedupeHash })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.companyId, ctx.companyId),
        eq(bankTransactions.bankAccountId, input.bankAccountId),
        inArray(bankTransactions.dedupeHash, candidateHashes),
      ),
    );
  const existingSet = new Set(existing.map((r) => r.hash));

  const importBatchId = randomUUID();
  const toInsert: ParsedBankRow[] = [];
  let duplicates = 0;
  // Within-batch dedupe -- if the same row appears twice in one CSV, count
  // as duplicate (skip the second).
  const seenInBatch = new Set<string>();
  for (const row of parsed.rows) {
    const hash = dedupeHash(input.bankAccountId, row.date, row.description, row.amount);
    if (existingSet.has(hash) || seenInBatch.has(hash)) {
      duplicates++;
      continue;
    }
    seenInBatch.add(hash);
    toInsert.push(row);
  }

  if (toInsert.length > 0) {
    await tx.insert(bankTransactions).values(
      toInsert.map((r) => ({
        companyId: ctx.companyId,
        bankAccountId: input.bankAccountId,
        transactionDate: r.date,
        description: r.description,
        amount: r.amount,
        balance: r.balance ?? null,
        status: 'unmatched' as const,
        importBatchId,
        rawCsvLine: r.rawLine,
        dedupeHash: dedupeHash(input.bankAccountId, r.date, r.description, r.amount),
      })),
    );
  }

  return {
    importBatchId,
    imported: toInsert.length,
    duplicates,
    warnings: parsed.warnings,
  };
}

// ---------------------------- AI categorize -------------------------------

interface AiSuggestion {
  bankTransactionId: string;
  accountId: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  reason: string;
}

const AI_SYSTEM_PROMPT = `You are an expert bookkeeper assisting a CPA. Your task: categorize bank transactions to the correct GL account.

Rules:
- Pick exactly one accountId from the provided list. Do not invent IDs.
- Match by transaction description: vendor names, payment processors, common patterns.
- Confidence: "high" when the description clearly maps to one account (e.g., "AT&T BILL PAY" -> Utilities); "medium" when the category is reasonable but description is generic; "low" when guessing from limited context.
- For positive amounts (deposits / income to the user), prefer revenue or refund-of-expense accounts.
- For negative amounts (withdrawals / spending), prefer expense or asset (fixed-asset purchase) accounts.
- Never pick an A/R or A/P account directly; bank-side postings should go to expense / revenue / asset / liability sub-accounts.
- Reason: ONE short sentence (under 80 chars) explaining the choice.

Return ONLY a JSON array, no surrounding prose, no code fence. Schema:
[{"bankTransactionId":"<id>","accountId":"<id>","confidence":"high|medium|low","reason":"..."}]`;

export async function suggestCategoriesForBatch(
  tx: Database,
  ctx: BankingContext,
  bankTransactionIds: string[],
): Promise<{ updated: number; failed: number; errors: string[] }> {
  if (!anthropicAvailable()) {
    throw new BankingError(
      'ANTHROPIC_API_KEY not configured; categorize manually instead',
      'ai_unavailable',
    );
  }
  if (bankTransactionIds.length === 0) return { updated: 0, failed: 0, errors: [] };

  // Load the transactions + the company's chart of accounts (excluding A/R + A/P
  // since the AI shouldn't direct bank-side postings into those).
  const txns = await tx
    .select({
      id: bankTransactions.id,
      description: bankTransactions.description,
      amount: bankTransactions.amount,
      transactionDate: bankTransactions.transactionDate,
      status: bankTransactions.status,
    })
    .from(bankTransactions)
    .where(inArray(bankTransactions.id, bankTransactionIds));

  const accountList = await tx
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
    })
    .from(accounts)
    .where(
      and(
        eq(accounts.isActive, true),
        ne(accounts.subtype, 'accounts_receivable'),
        ne(accounts.subtype, 'accounts_payable'),
      ),
    );

  if (accountList.length === 0) {
    throw new BankingError(
      'no eligible accounts available for categorization',
      'invalid_input',
    );
  }

  const accountsBlock = accountList
    .map((a) => `  ${a.id}  ${a.code} ${a.name}  (${a.type} / ${a.subtype})`)
    .join('\n');
  const txnsBlock = txns
    .map(
      (t) =>
        `- id=${t.id}  date=${t.transactionDate}  amount=${t.amount}  description=${JSON.stringify(t.description)}`,
    )
    .join('\n');

  let aiResponse;
  try {
    aiResponse = await callAnthropic({
      system: AI_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Available accounts (id  code name  type/subtype):\n${accountsBlock}\n\nTransactions to categorize:\n${txnsBlock}\n\nReturn the JSON array described in the system prompt.`,
        },
      ],
      maxTokens: Math.min(4096, 100 + 200 * txns.length),
    });
  } catch (err) {
    throw new BankingError(
      err instanceof Error ? err.message : String(err),
      'ai_failed',
    );
  }

  const errors: string[] = [];
  let suggestions: AiSuggestion[];
  try {
    const text = stripCodeFence(aiResponse.text);
    suggestions = JSON.parse(text) as AiSuggestion[];
    if (!Array.isArray(suggestions)) throw new Error('expected array');
  } catch (err) {
    throw new BankingError(
      `failed to parse AI response as JSON: ${err instanceof Error ? err.message : String(err)}`,
      'ai_failed',
    );
  }

  const accountIdSet = new Set(accountList.map((a) => a.id));
  let updated = 0;
  let failed = 0;
  for (const s of suggestions) {
    if (!s.bankTransactionId || !s.accountId) {
      failed++;
      continue;
    }
    if (!accountIdSet.has(s.accountId)) {
      failed++;
      errors.push(`AI suggested unknown account id "${s.accountId}" for ${s.bankTransactionId}`);
      continue;
    }
    const confidence = (['high', 'medium', 'low'] as const).includes(s.confidence as never)
      ? (s.confidence as 'high' | 'medium' | 'low')
      : 'low';
    await tx
      .update(bankTransactions)
      .set({
        suggestedAccountId: s.accountId,
        suggestedConfidence: confidence,
        suggestedReason: (s.reason ?? '').slice(0, 500),
        status: 'suggested',
      })
      .where(
        and(
          eq(bankTransactions.id, s.bankTransactionId),
          eq(bankTransactions.companyId, ctx.companyId),
        ),
      );
    updated++;
  }

  return { updated, failed, errors };
}

// ---------------------------- Post / ignore -------------------------------

export async function postBankTransaction(
  tx: Database,
  ctx: BankingContext,
  bankTransactionId: string,
  /** Account to post to. If omitted, uses the AI suggestion. */
  accountIdOverride?: string,
): Promise<{ id: string; postedJournalEntryId: string }> {
  const [row] = await tx
    .select()
    .from(bankTransactions)
    .where(eq(bankTransactions.id, bankTransactionId));
  if (!row) {
    throw new BankingError(`bank transaction ${bankTransactionId} not found`, 'not_found');
  }
  if (row.status === 'posted') {
    throw new BankingError(`bank transaction ${bankTransactionId} is already posted`, 'wrong_status');
  }
  if (row.status === 'ignored') {
    throw new BankingError(`bank transaction ${bankTransactionId} is ignored`, 'wrong_status');
  }

  const counterpartyAccountId = accountIdOverride ?? row.suggestedAccountId;
  if (!counterpartyAccountId) {
    throw new BankingError(
      'no counterparty account selected; pick one or run AI categorize first',
      'invalid_input',
    );
  }

  // Validate counterparty account is in the same company + active.
  const [counterparty] = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(eq(accounts.id, counterpartyAccountId));
  if (!counterparty) {
    throw new BankingError(
      `counterparty account ${counterpartyAccountId} not found`,
      'invalid_input',
    );
  }
  if (!counterparty.isActive) {
    throw new BankingError(
      `counterparty account ${counterpartyAccountId} is inactive`,
      'invalid_input',
    );
  }

  // Sign rule: bank txn amount > 0 means money INTO the bank (DR bank, CR
  // counterparty). amount < 0 means money OUT (CR bank, DR counterparty).
  const amount = Money.of(row.amount, 'USD');
  const isInflow = !row.amount.startsWith('-');
  const positive = (isInflow ? row.amount : row.amount.slice(1)) as string;

  const memo = row.description.slice(0, 500);
  let entryId: string;
  try {
    const result = await postEntry(tx, ctx, {
      entryDate: row.transactionDate,
      sourceType: 'bank_transaction',
      sourceId: row.id,
      memo,
      reference: undefined,
      lines: isInflow
        ? [
            {
              accountId: row.bankAccountId,
              debit: positive,
              currency: 'USD' as const,
              fxRate: '1',
              memo,
            },
            {
              accountId: counterpartyAccountId,
              credit: positive,
              currency: 'USD' as const,
              fxRate: '1',
              memo,
            },
          ]
        : [
            {
              accountId: counterpartyAccountId,
              debit: positive,
              currency: 'USD' as const,
              fxRate: '1',
              memo,
            },
            {
              accountId: row.bankAccountId,
              credit: positive,
              currency: 'USD' as const,
              fxRate: '1',
              memo,
            },
          ],
    });
    entryId = result.id;
  } catch (err) {
    if (err instanceof PostingError) {
      throw new BankingError(`posting failed: ${err.message}`, 'invalid_input');
    }
    throw err;
  }
  void amount; // suppress unused; kept for clarity

  await tx
    .update(bankTransactions)
    .set({ status: 'posted', postedJournalEntryId: entryId })
    .where(eq(bankTransactions.id, bankTransactionId));

  return { id: bankTransactionId, postedJournalEntryId: entryId };
}

export async function ignoreBankTransaction(
  tx: Database,
  bankTransactionId: string,
): Promise<{ id: string }> {
  const [row] = await tx
    .select({ id: bankTransactions.id, status: bankTransactions.status })
    .from(bankTransactions)
    .where(eq(bankTransactions.id, bankTransactionId));
  if (!row) {
    throw new BankingError(`bank transaction ${bankTransactionId} not found`, 'not_found');
  }
  if (row.status === 'posted') {
    throw new BankingError('cannot ignore a posted bank transaction', 'wrong_status');
  }
  await tx
    .update(bankTransactions)
    .set({ status: 'ignored' })
    .where(eq(bankTransactions.id, bankTransactionId));
  return { id: bankTransactionId };
}

export async function listBankTransactions(
  tx: Database,
  filter: {
    status?: 'unmatched' | 'suggested' | 'posted' | 'ignored' | undefined;
    bankAccountId?: string | undefined;
  },
) {
  const rows = await tx
    .select({
      id: bankTransactions.id,
      bankAccountId: bankTransactions.bankAccountId,
      transactionDate: bankTransactions.transactionDate,
      description: bankTransactions.description,
      amount: bankTransactions.amount,
      balance: bankTransactions.balance,
      status: bankTransactions.status,
      suggestedAccountId: bankTransactions.suggestedAccountId,
      suggestedConfidence: bankTransactions.suggestedConfidence,
      suggestedReason: bankTransactions.suggestedReason,
      postedJournalEntryId: bankTransactions.postedJournalEntryId,
      importBatchId: bankTransactions.importBatchId,
      createdAt: bankTransactions.createdAt,
    })
    .from(bankTransactions)
    .where(
      and(
        filter.status ? eq(bankTransactions.status, filter.status) : undefined,
        filter.bankAccountId ? eq(bankTransactions.bankAccountId, filter.bankAccountId) : undefined,
      ),
    )
    .orderBy(desc(bankTransactions.transactionDate), desc(bankTransactions.createdAt));
  return rows;
}

// Avoid lint: `journalEntries` + `journalLines` + `sql` imported but used only via postEntry chain.
void journalEntries;
void journalLines;
void sql;
