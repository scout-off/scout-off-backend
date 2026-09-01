-- Migration 014: enforce NOT NULL on audit_log.hash / event_source (PostgreSQL)
--
-- 012_audit_log_hash_chain_postgres.sql added `hash` and `event_source` as
-- nullable columns (no NOT NULL, no DEFAULT for `hash`), unlike the SQLite
-- schema which has always required both — silently weakening the
-- tamper-evidence guarantee the hash chain exists to provide, since a NULL
-- hash breaks the chain without being detectable as a rejected write.
--
-- Backfill any existing NULLs to the same defaults SQLite has always used,
-- then tighten both columns to match.
UPDATE audit_log SET hash = '' WHERE hash IS NULL;
UPDATE audit_log SET event_source = 'admin_action' WHERE event_source IS NULL;

ALTER TABLE audit_log ALTER COLUMN hash SET DEFAULT '';
ALTER TABLE audit_log ALTER COLUMN hash SET NOT NULL;
ALTER TABLE audit_log ALTER COLUMN event_source SET DEFAULT 'admin_action';
ALTER TABLE audit_log ALTER COLUMN event_source SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_log_hash ON audit_log (hash);
