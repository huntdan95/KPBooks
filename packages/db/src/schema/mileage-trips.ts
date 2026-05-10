import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { companies, users } from './companies';
import { journalEntries } from './ledger';

export const mileageTripStatusEnum = pgEnum('mileage_trip_status', [
  'logged',
  'posted',
]);

/**
 * mileage_trips
 *
 * Per-trip business mileage log. Stores the rate it was logged at so the
 * historical deduction never silently shifts when the IRS publishes a new
 * standard rate. Posting is batched -- bookkeeper picks a date range, the
 * service writes one JE summing all 'logged' trips and flips them to
 * 'posted'. Posted trips are immutable (DB lock-after-post trigger).
 */
export const mileageTrips = pgTable(
  'mileage_trips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    tripDate: date('trip_date', { mode: 'string' }).notNull(),
    startLocation: text('start_location'),
    endLocation: text('end_location'),
    vehicle: text('vehicle'),
    startOdometer: numeric('start_odometer', { precision: 10, scale: 1 }),
    endOdometer: numeric('end_odometer', { precision: 10, scale: 1 }),
    miles: numeric('miles', { precision: 10, scale: 2 }).notNull(),
    purpose: text('purpose').notNull(),
    notes: text('notes'),
    /** Rate locked at trip-creation time (IRS standard mileage rate at the time). */
    ratePerMile: numeric('rate_per_mile', { precision: 19, scale: 6 }).notNull(),
    /** Snapshot product = miles × rate_per_mile, stored to avoid repeated rounding. */
    deduction: numeric('deduction', { precision: 19, scale: 4 }).notNull(),
    status: mileageTripStatusEnum('status').notNull().default('logged'),
    postedJournalEntryId: uuid('posted_journal_entry_id').references(
      () => journalEntries.id,
      { onDelete: 'set null' },
    ),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyStatusDateIdx: index('mileage_trips_company_status_date_idx').on(
      t.companyId,
      t.status,
      t.tripDate,
    ),
    companyDateIdx: index('mileage_trips_company_date_idx').on(t.companyId, t.tripDate),
    milesPositive: check('mileage_trips_miles_positive', sql`${t.miles} > 0`),
    ratePositive: check('mileage_trips_rate_positive', sql`${t.ratePerMile} > 0`),
    deductionNonNegative: check(
      'mileage_trips_deduction_non_negative',
      sql`${t.deduction} >= 0`,
    ),
    purposeNonempty: check('mileage_trips_purpose_nonempty', sql`length(${t.purpose}) > 0`),
    odometerOrder: check(
      'mileage_trips_odometer_order',
      sql`${t.startOdometer} IS NULL OR ${t.endOdometer} IS NULL OR ${t.endOdometer} >= ${t.startOdometer}`,
    ),
    postedConsistency: check(
      'mileage_trips_posted_consistency',
      sql`(${t.status} = 'posted') = (${t.postedJournalEntryId} IS NOT NULL)
       AND (${t.status} = 'posted') = (${t.postedAt} IS NOT NULL)`,
    ),
  }),
);

export type MileageTrip = typeof mileageTrips.$inferSelect;
export type NewMileageTrip = typeof mileageTrips.$inferInsert;
