import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { companies, users } from './companies';
import { depreciationMethodEnum, fixedAssetStatusEnum } from './enums';
import { journalEntries } from './ledger';

/**
 * fixed_assets
 *
 * One row per capitalized asset (vehicle, computer, equipment, etc.). The
 * bookkeeper enters cost + useful life + the three GL accounts (asset,
 * accumulated depreciation, depreciation expense). The service runs
 * straight-line monthly depreciation, posting one JE per asset-month via the
 * existing posting service. `accumulated_depreciation` and
 * `last_depreciated_through` are caches kept in sync with those JEs inside
 * the same tx, so the list view doesn't have to re-aggregate.
 *
 * State machine:
 *   active   -> depreciating
 *   disposed -> final disposal JE has been written; row is read-only
 */
export const fixedAssets = pgTable(
  'fixed_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    category: text('category'),
    description: text('description'),
    inServiceDate: date('in_service_date', { mode: 'string' }).notNull(),
    cost: numeric('cost', { precision: 19, scale: 4 }).notNull(),
    salvageValue: numeric('salvage_value', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    usefulLifeMonths: integer('useful_life_months').notNull(),
    method: depreciationMethodEnum('method').notNull().default('straight_line'),
    /** GL account where the original purchase debited (subtype=fixed_asset). */
    assetAccountId: uuid('asset_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    /** Contra-asset; CR each month. Subtype is usually fixed_asset or other_asset. */
    accumDeprAccountId: uuid('accum_depr_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    /** Expense account; DR each month. Subtype=expense. */
    deprExpenseAccountId: uuid('depr_expense_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'restrict' }),
    /** Cached running total — sum of monthly depreciation JEs. */
    accumulatedDepreciation: numeric('accumulated_depreciation', {
      precision: 19,
      scale: 4,
    })
      .notNull()
      .default('0'),
    /** Last day-of-month that depreciation has been posted through. NULL = never run. */
    lastDepreciatedThrough: date('last_depreciated_through', { mode: 'string' }),
    status: fixedAssetStatusEnum('status').notNull().default('active'),
    disposalDate: date('disposal_date', { mode: 'string' }),
    disposalProceeds: numeric('disposal_proceeds', { precision: 19, scale: 4 }),
    disposalCashAccountId: uuid('disposal_cash_account_id').references(
      (): AnyPgColumn => accounts.id,
      { onDelete: 'restrict' },
    ),
    disposalJournalEntryId: uuid('disposal_journal_entry_id').references(
      (): AnyPgColumn => journalEntries.id,
      { onDelete: 'set null' },
    ),
    memo: text('memo'),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyStatusIdx: index('fixed_assets_company_status_idx').on(t.companyId, t.status),
    companyInServiceIdx: index('fixed_assets_company_in_service_idx').on(
      t.companyId,
      t.inServiceDate,
    ),
    assetAccountIdx: index('fixed_assets_asset_account_idx').on(t.assetAccountId),
    costPositive: check('fixed_assets_cost_positive', sql`${t.cost} > 0`),
    salvageNonNegative: check(
      'fixed_assets_salvage_non_negative',
      sql`${t.salvageValue} >= 0`,
    ),
    salvageLtCost: check(
      'fixed_assets_salvage_lt_cost',
      sql`${t.salvageValue} < ${t.cost}`,
    ),
    lifePositive: check('fixed_assets_life_positive', sql`${t.usefulLifeMonths} > 0`),
    accumNonNegative: check(
      'fixed_assets_accum_non_negative',
      sql`${t.accumulatedDepreciation} >= 0`,
    ),
    accumLteDepreciable: check(
      'fixed_assets_accum_lte_depreciable',
      sql`${t.accumulatedDepreciation} <= (${t.cost} - ${t.salvageValue})`,
    ),
    disposedConsistency: check(
      'fixed_assets_disposed_consistency',
      sql`(${t.status} = 'disposed') = (${t.disposalDate} IS NOT NULL)`,
    ),
    disposalAfterInService: check(
      'fixed_assets_disposal_after_in_service',
      sql`${t.disposalDate} IS NULL OR ${t.disposalDate} >= ${t.inServiceDate}`,
    ),
    disposalProceedsNonNegative: check(
      'fixed_assets_disposal_proceeds_non_negative',
      sql`${t.disposalProceeds} IS NULL OR ${t.disposalProceeds} >= 0`,
    ),
  }),
);

export type FixedAsset = typeof fixedAssets.$inferSelect;
export type NewFixedAsset = typeof fixedAssets.$inferInsert;
