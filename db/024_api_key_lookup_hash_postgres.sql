-- Migration 024: indexed deterministic lookup hash for API keys (#1033) (PostgreSQL)
--
-- PostgreSQL counterpart of db/024_api_key_lookup_hash.sql. See that file for
-- the full rationale, the security note (lookup_hash locates a candidate row;
-- key_hash remains the authentication proof), and the lazy-backfill strategy
-- for keys issued before this migration.
--
-- runMigrations() applies every *.sql file under db/ against whichever driver
-- is configured, converting cross-driver where needed, so both this file and
-- the SQLite variant run on both backends. ADD COLUMN IF NOT EXISTS keeps this
-- file a no-op when the SQLite-flavoured file has already added the column.

ALTER TABLE IF EXISTS api_keys ADD COLUMN IF NOT EXISTS lookup_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_lookup_hash
  ON api_keys (lookup_hash);

CREATE INDEX IF NOT EXISTS idx_api_keys_lookup_pending
  ON api_keys (id) WHERE lookup_hash IS NULL AND revoked_at IS NULL;
