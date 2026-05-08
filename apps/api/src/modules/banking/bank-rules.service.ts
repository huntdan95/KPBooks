import {
  type Database,
  accounts,
  bankRules,
  bankTransactions,
  type BankRule,
} from '@kpbooks/db';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

/**
 * bank-rules.service — user-defined patterns that auto-categorize bank
 * transactions on CSV import, before the AI step. The first active rule
 * (ascending priority, then ascending createdAt) whose pattern + amount-sign
 * filter matches a transaction wins, and pre-fills suggestedAccountId on the
 * row with confidence='high'.
 *
 * Rules are intentionally simple; if you need anything more sophisticated
 * (e.g. compound conditions, vendor-name resolution), use AI categorize
 * for that line and save a manual override.
 */

export interface MatchableTxn {
  id: string;
  description: string;
  amount: string; // signed decimal string, e.g. "-12.50"
  bankAccountId: string;
}

export type RuleForMatching = Pick<
  BankRule,
  | 'id'
  | 'bankAccountId'
  | 'matchType'
  | 'matchValue'
  | 'amountSign'
  | 'targetAccountId'
  | 'memoTemplate'
  | 'priority'
>;

/**
 * Pure matcher. Returns true when the rule applies to the line. Exported
 * for unit tests; the import flow uses the DB-backed batch applier below.
 */
export function ruleMatches(rule: RuleForMatching, line: MatchableTxn): boolean {
  // Account scope: NULL = any; otherwise must match.
  if (rule.bankAccountId && rule.bankAccountId !== line.bankAccountId) return false;

  // Amount-sign filter.
  const negative = line.amount.startsWith('-');
  if (rule.amountSign === 'positive' && negative) return false;
  if (rule.amountSign === 'negative' && !negative) return false;

  const desc = line.description.trim();
  const target = rule.matchValue.trim();
  if (target.length === 0) return false;

  switch (rule.matchType) {
    case 'contains':
      return desc.toLowerCase().includes(target.toLowerCase());
    case 'starts_with':
      return desc.toLowerCase().startsWith(target.toLowerCase());
    case 'ends_with':
      return desc.toLowerCase().endsWith(target.toLowerCase());
    case 'exact':
      return desc.toLowerCase() === target.toLowerCase();
    case 'regex':
      try {
        return new RegExp(target, 'i').test(desc);
      } catch {
        // Bad regex: skip rather than fail the whole import.
        return false;
      }
    default:
      return false;
  }
}

/**
 * Run all active rules against a freshly-imported batch and pre-fill
 * suggestedAccountId on matches. Updates each rule's hitCount + lastHitAt
 * for telemetry. Returns the number of transactions that matched a rule.
 *
 * Caller is responsible for filtering by status='unmatched' if they want
 * to avoid clobbering AI suggestions.
 */
export async function applyRulesToImportBatch(
  tx: Database,
  companyId: string,
  importBatchId: string,
): Promise<{ matched: number; rulesApplied: number }> {
  const lines = await tx
    .select({
      id: bankTransactions.id,
      description: bankTransactions.description,
      amount: bankTransactions.amount,
      bankAccountId: bankTransactions.bankAccountId,
    })
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.companyId, companyId),
        eq(bankTransactions.importBatchId, importBatchId),
        eq(bankTransactions.status, 'unmatched'),
      ),
    );
  if (lines.length === 0) return { matched: 0, rulesApplied: 0 };

  const rules = await tx
    .select()
    .from(bankRules)
    .where(and(eq(bankRules.companyId, companyId), eq(bankRules.isActive, true)))
    .orderBy(asc(bankRules.priority), asc(bankRules.createdAt));
  if (rules.length === 0) return { matched: 0, rulesApplied: 0 };

  // Validate target accounts are still active before letting a rule fire --
  // no point pre-filling a suggestion the user can't post.
  const targetIds = Array.from(new Set(rules.map((r) => r.targetAccountId)));
  const targetAccounts = await tx
    .select({ id: accounts.id, isActive: accounts.isActive })
    .from(accounts)
    .where(inArray(accounts.id, targetIds));
  const activeTargets = new Set(targetAccounts.filter((a) => a.isActive).map((a) => a.id));

  let matchedCount = 0;
  const ruleHits = new Map<string, number>();

  for (const line of lines) {
    for (const rule of rules) {
      if (!activeTargets.has(rule.targetAccountId)) continue;
      if (!ruleMatches(rule, line)) continue;

      const memo = rule.memoTemplate?.trim();
      await tx
        .update(bankTransactions)
        .set({
          status: 'suggested',
          suggestedAccountId: rule.targetAccountId,
          suggestedConfidence: 'high',
          suggestedReason: `Matched rule: ${rule.name}`,
          ...(memo ? { description: memo } : {}),
        })
        .where(eq(bankTransactions.id, line.id));

      matchedCount++;
      ruleHits.set(rule.id, (ruleHits.get(rule.id) ?? 0) + 1);
      break; // first-rule-wins
    }
  }

  // Bulk-update hit counts.
  for (const [ruleId, hits] of ruleHits) {
    await tx
      .update(bankRules)
      .set({
        hitCount: sql`${bankRules.hitCount} + ${hits}`,
        lastHitAt: new Date(),
      })
      .where(eq(bankRules.id, ruleId));
  }

  return { matched: matchedCount, rulesApplied: ruleHits.size };
}
