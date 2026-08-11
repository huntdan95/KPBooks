-- Migration 0029 does `GRANT kpbooks_app TO neondb_owner` — Neon's
-- migration-owner role. It doesn't exist in a local Postgres, and the
-- migration file can't be edited (its hash is recorded in the live DB),
-- so create a stand-in role before any migrations run.
--
-- NOTE: docker-entrypoint-initdb.d scripts only run when the data volume
-- is EMPTY. For an existing ./.postgres-data volume, run this once by hand:
--   docker exec -i kpbooks-postgres psql -U kpbooks -d kpbooks -c "CREATE ROLE neondb_owner NOLOGIN"
DO $$ BEGIN
  CREATE ROLE neondb_owner NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
