-- KPBooks 0029 -- HARD FIX for cross-tenant data leak.
--
-- ROOT CAUSE
-- ----------
-- Neon's `neondb_owner` role has the BYPASSRLS attribute set. That attribute
-- TRUMPS ALL RLS policies AND `ALTER TABLE ... FORCE ROW LEVEL SECURITY`. The
-- diagnostic from this incident:
--   relrowsecurity=t, relforcerowsecurity=t, GUC set correctly,
--   accounts_company_isolation policy in place, AND STILL the table returned
--   ALL rows from EVERY company in one query. Per Postgres docs:
--   "The BYPASSRLS attribute always allows a role to bypass row security
--    policies; this attribute can only be set or removed by superuser."
--
-- We can't ALTER ROLE neondb_owner NOBYPASSRLS (Neon doesn't expose a
-- superuser to project users). Instead we create a sibling role without
-- BYPASSRLS, GRANT it to neondb_owner so the migration owner can SET ROLE
-- into it, and patch the API to SET LOCAL ROLE kpbooks_app at the start of
-- every per-request transaction. RLS now fires correctly.
--
-- The migration runner itself keeps using neondb_owner (so it can DDL freely
-- and write to kpbooks_migrations without RLS interference).
--
-- The SECURITY DEFINER lookup_w9_token function ALSO keeps running as
-- neondb_owner (its function-owner privilege), so the public no-auth W-9
-- upload route can still read the token row before any tenant context is
-- known. Once the lookup returns, the public route SET LOCAL ROLEs into
-- kpbooks_app for the rest of the work, so the actual document insert
-- and the token-mark-used update both flow through RLS.

DO $$ BEGIN
  CREATE ROLE kpbooks_app NOLOGIN NOBYPASSRLS;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Make neondb_owner a member of kpbooks_app so it can `SET LOCAL ROLE
-- kpbooks_app` inside transactions. This is the entry point the API uses.
GRANT kpbooks_app TO neondb_owner;

-- Schema usage (table lookups need this).
GRANT USAGE ON SCHEMA public TO kpbooks_app;

-- Full read/write on every existing table + sequence + function.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO kpbooks_app;
GRANT USAGE, SELECT, UPDATE          ON ALL SEQUENCES IN SCHEMA public TO kpbooks_app;
GRANT EXECUTE                        ON ALL FUNCTIONS IN SCHEMA public TO kpbooks_app;

-- Default privileges so future tables / sequences / functions created by
-- neondb_owner are also accessible by kpbooks_app without manual GRANTs.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kpbooks_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO kpbooks_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO kpbooks_app;
