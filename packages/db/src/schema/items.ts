import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { companies } from './companies';
import { itemTypeEnum } from './enums';

/**
 * items
 *
 * A saved catalog of services / non-inventory items the bookkeeper picks
 * from when adding a line on an invoice or a bill. Pre-fills description +
 * price + GL account so a 5-second QuickBooks line entry stays a 5-second
 * line entry instead of typing every field from scratch.
 *
 * Inventory items (qty on hand, COGS journal entries on sale) are NOT in
 * this slice -- that workflow needs its own slice with qty change posting.
 *
 * An item can be:
 *   - sales-only (sales_account_id set, purchase_account_id null) -- shows
 *     up only in the invoice line picker
 *   - purchase-only (purchase_account_id set, sales_account_id null) --
 *     shows up only in the bill line picker
 *   - both (both set) -- shows up in both, e.g. a sub-contractor cost the
 *     business resells at markup
 */
export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Optional SKU. Unique within a company when set. */
    sku: text('sku'),
    itemType: itemTypeEnum('item_type').notNull().default('service'),
    // ── Sales side ──────────────────────────────────────────────────────
    salesDescription: text('sales_description'),
    salesPrice: numeric('sales_price', { precision: 19, scale: 4 }).notNull().default('0'),
    salesAccountId: uuid('sales_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    taxable: boolean('taxable').notNull().default(false),
    // ── Purchase side ───────────────────────────────────────────────────
    purchaseDescription: text('purchase_description'),
    purchaseCost: numeric('purchase_cost', { precision: 19, scale: 4 }),
    purchaseAccountId: uuid('purchase_account_id').references(() => accounts.id, {
      onDelete: 'set null',
    }),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyActiveIdx: index('items_company_active_idx').on(t.companyId, t.isActive),
    companyNameIdx: index('items_company_name_idx').on(t.companyId, t.name),
    companySkuIdx: uniqueIndex('items_company_sku_idx')
      .on(t.companyId, t.sku)
      .where(sql`${t.sku} IS NOT NULL`),
    salesPriceNonNeg: check('items_sales_price_non_negative', sql`${t.salesPrice} >= 0`),
    purchaseCostNonNeg: check(
      'items_purchase_cost_non_negative',
      sql`${t.purchaseCost} IS NULL OR ${t.purchaseCost} >= 0`,
    ),
  }),
);

export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
