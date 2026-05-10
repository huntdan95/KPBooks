-- KPBooks 0029a -- Split out from 0030 so ALTER TYPE commits before use.
--
-- Postgres rejects `ALTER TYPE foo ADD VALUE 'x'` followed by a query that
-- references 'x' in the SAME transaction (errcode 55P04: "unsafe use of new
-- value"). The migrate runner wraps each .sql file in its own tx; splitting
-- the ADD VALUE into its own file lets 0030 reference 'subcontractor' freely
-- in its CREATE INDEX ... WHERE worker_type = 'subcontractor' clauses.
--
-- Filename uses the '0029a' suffix so lexicographic order keeps it between
-- 0029_* and 0030_*. This file is idempotent (IF NOT EXISTS) and trivially
-- safe to re-run.

ALTER TYPE worker_type ADD VALUE IF NOT EXISTS 'subcontractor';
