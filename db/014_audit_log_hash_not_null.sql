-- Migration 014: enforce NOT NULL on audit_log.hash / event_source (SQLite)
-- No-op here — 012_audit_log_hash_chain.sql already declared both columns
-- `NOT NULL DEFAULT ...` on SQLite. This file exists so the PostgreSQL
-- counterpart (014_audit_log_hash_not_null_postgres.sql), which backfills
-- and tightens the equivalent PostgreSQL columns, has a matching filename
-- for runMigrations() to pair against.
CREATE INDEX IF NOT EXISTS idx_audit_log_hash ON audit_log (hash);
