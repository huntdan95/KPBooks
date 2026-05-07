import { sql } from 'drizzle-orm';
import {
  date,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { membershipRoleEnum } from './enums.js';

/**
 * companies
 * One row per accounting client (the office serves many).
 * Every row in domain tables carries a company_id; RLS policies enforce isolation.
 */
export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    ein: text('ein'),
    fiscalYearStart: date('fiscal_year_start', { mode: 'string' }).notNull().default('01-01'),
    baseCurrency: text('base_currency').notNull().default('USD'),
    closedThroughDate: date('closed_through_date', { mode: 'string' }),
    address: jsonb('address').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nameIdx: index('companies_name_idx').on(t.name),
  }),
);

/**
 * users
 * One row per human, keyed off Firebase Auth UID.
 * We mirror Firebase identities here so we can join on FK; we do NOT store passwords.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    firebaseUid: text('firebase_uid').notNull(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    disabled: timestamp('disabled', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    firebaseUidIdx: uniqueIndex('users_firebase_uid_idx').on(t.firebaseUid),
    emailIdx: uniqueIndex('users_email_idx').on(sql`lower(${t.email})`),
  }),
);

/**
 * memberships
 * (user, company) → role. Accountants get many memberships across client companies.
 */
export const memberships = pgTable(
  'memberships',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    role: membershipRoleEnum('role').notNull().default('bookkeeper'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.companyId] }),
    companyIdx: index('memberships_company_idx').on(t.companyId),
  }),
);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
