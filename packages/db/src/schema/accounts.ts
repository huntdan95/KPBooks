import {
  type AnyPgColumn,
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { accountSubtypeEnum, accountTypeEnum } from './enums';
import { companies } from './companies';

/**
 * accounts (Chart of Accounts)
 * Hierarchical via parent_id. `code` is the account number (often "1000", "4000.10").
 */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    type: accountTypeEnum('type').notNull(),
    subtype: accountSubtypeEnum('subtype').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => accounts.id, { onDelete: 'set null' }),
    currency: text('currency').notNull().default('USD'),
    description: text('description'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyCodeIdx: uniqueIndex('accounts_company_code_idx').on(t.companyId, t.code),
    companyTypeIdx: index('accounts_company_type_idx').on(t.companyId, t.type),
    parentIdx: index('accounts_parent_idx').on(t.parentId),
  }),
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
