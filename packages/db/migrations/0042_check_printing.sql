-- KPBooks 0042 -- check printing on BLANK check stock.
--
-- The practice prints checks for ~250 client companies, so pre-printed stock
-- is impractical: it would mean a separate box of paper per client bank
-- account. They use blank security paper and print everything -- bank block,
-- payee, amounts, and the MICR line along the bottom.
--
-- That means the routing and account numbers have to live here, per bank
-- account, because nothing else in the schema carries them.
--
-- SENSITIVE DATA. A routing + account number pair is enough to originate an
-- ACH debit, so these columns are as sensitive as anything in the database.
-- They are protected by the same per-company RLS as the accounts table they
-- hang off (policy accounts_company_isolation, migration 0001), and are never
-- returned by the generic /ledger/accounts list -- only by the check-printing
-- endpoints, which check the caller's role.

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS check_routing_number   text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS check_account_number   text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS check_bank_name        text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS check_bank_address     jsonb;
-- Fractional routing code ("12-3456/7890"), printed top-right by convention.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS check_fractional_code  text;
-- Next number to print. Allocated and incremented when a check is issued so
-- two users cannot print the same number.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS next_check_number      integer;
-- Second signature line above this amount (a common control), NULL = never.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS second_signature_over  numeric(19,4);

--> statement-breakpoint

-- A routing number is 9 digits; storing anything else guarantees an unreadable
-- MICR line and a rejected check, so reject it at the door rather than at the
-- bank. Account numbers vary by institution (4-17 digits is the practical
-- range) and may not contain separators.
DO $$ BEGIN
  ALTER TABLE accounts ADD CONSTRAINT accounts_check_routing_format
    CHECK (check_routing_number IS NULL OR check_routing_number ~ '^[0-9]{9}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE accounts ADD CONSTRAINT accounts_check_account_format
    CHECK (check_account_number IS NULL OR check_account_number ~ '^[0-9]{4,17}$');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE accounts ADD CONSTRAINT accounts_next_check_number_positive
    CHECK (next_check_number IS NULL OR next_check_number > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

-- Only a bank account can print checks. Enforced as a partial-uniqueness-free
-- check rather than a trigger so it stays cheap.
DO $$ BEGIN
  ALTER TABLE accounts ADD CONSTRAINT accounts_check_settings_bank_only
    CHECK (
      check_routing_number IS NULL
      OR subtype = 'bank'
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

-- Issued checks. One row per printed check so a number is never reused and
-- the register can be reconciled against the bank.
CREATE TABLE IF NOT EXISTS printed_checks (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id     uuid NOT NULL REFERENCES accounts(id),
  check_number        integer NOT NULL,
  check_date          date NOT NULL,
  payee_name          text NOT NULL,
  amount              numeric(19,4) NOT NULL,
  memo                text,
  -- What the check paid. Nullable so a check can be printed for a payment,
  -- a payroll line, or nothing at all (a hand-written-style one-off).
  payment_id          uuid REFERENCES payments(id),
  journal_entry_id    uuid REFERENCES journal_entries(id),
  voided_at           timestamptz,
  void_reason         text,
  created_by          uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT printed_checks_amount_positive CHECK (amount > 0),
  CONSTRAINT printed_checks_void_consistency
    CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);

--> statement-breakpoint

-- A check number must be unique per bank account. This is the guard that stops
-- two people printing check 1001 twice; voided checks keep their number so the
-- gap is visible during reconciliation.
CREATE UNIQUE INDEX IF NOT EXISTS printed_checks_account_number_idx
  ON printed_checks (bank_account_id, check_number);

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS printed_checks_company_date_idx
  ON printed_checks (company_id, check_date DESC);
