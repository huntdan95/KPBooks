-- KPBooks 0024 -- Add a phone column to companies so the 1099-NEC payer phone
-- box can be filled in. (Address already exists as jsonb.)
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone text;
