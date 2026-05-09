-- KPBooks 0030 -- Phase A of payroll-tracking module.
--
-- Adds:
--   1. 'subcontractor' value to the existing worker_type enum (1099 sub
--      is the construction-industry distinction the user runs into daily;
--      same IRS treatment as 1099 contractor but different operationally
--      because sub usually has employees, license, insurance, lien-waiver
--      sign-offs).
--   2. Two new enums for W-2 metadata: payroll_filing_status,
--      pay_schedule. Distinct from the existing pay_rate_basis -- that
--      one describes what your *rate* means ($25/hr vs $50,000/yr);
--      pay_schedule describes how often the *check* gets cut.
--   3. Tracking-only fields on vendors so the bookkeeper can record W-4
--      election, license + insurance + workers-comp expirations, and
--      whether a subcontractor lien-waiver is required by default.
--   4. lien_waiver_received + date fields on payments so each per-sub
--      payment carries its own sign-off state.
--
-- All fields are display-only -- KPBooks does not compute taxes or
-- generate W-2/941/940 forms (out of scope per the office workflow).

-- 1. Extend worker_type enum
ALTER TYPE worker_type ADD VALUE IF NOT EXISTS 'subcontractor';

--> statement-breakpoint

-- 2. New enums
DO $$ BEGIN
  CREATE TYPE payroll_filing_status AS ENUM (
    'single',
    'married_jointly',
    'married_separately',
    'head_of_household',
    'qualifying_widow'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE pay_schedule AS ENUM (
    'weekly',
    'biweekly',
    'semimonthly',
    'monthly'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

--> statement-breakpoint

-- 3. W-2 tracking columns on vendors
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS w2_filing_status        payroll_filing_status;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS w2_allowances           smallint;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS w2_additional_withholding numeric(19,4);
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS w2_state                text;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS pay_schedule            pay_schedule;

--> statement-breakpoint

-- Subcontractor compliance columns on vendors
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS license_number          text;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS license_state           text;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS license_expiration      date;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS insurance_general_liability_carrier       text;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS insurance_general_liability_policy_number text;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS insurance_general_liability_expiration    date;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS insurance_workers_comp_carrier        text;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS insurance_workers_comp_policy_number  text;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS insurance_workers_comp_expiration     date;
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS lien_waiver_required    boolean DEFAULT false NOT NULL;

--> statement-breakpoint

-- Helpful index for the compliance-expiring report (subs only).
CREATE INDEX IF NOT EXISTS vendors_subcontractor_license_exp_idx
  ON vendors (company_id, license_expiration)
  WHERE worker_type = 'subcontractor' AND license_expiration IS NOT NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS vendors_subcontractor_gl_exp_idx
  ON vendors (company_id, insurance_general_liability_expiration)
  WHERE worker_type = 'subcontractor' AND insurance_general_liability_expiration IS NOT NULL;

--> statement-breakpoint

CREATE INDEX IF NOT EXISTS vendors_subcontractor_wc_exp_idx
  ON vendors (company_id, insurance_workers_comp_expiration)
  WHERE worker_type = 'subcontractor' AND insurance_workers_comp_expiration IS NOT NULL;

--> statement-breakpoint

-- 4. Lien waiver tracking on payments (per-payment sign-off)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS lien_waiver_received      boolean;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS lien_waiver_received_date date;
