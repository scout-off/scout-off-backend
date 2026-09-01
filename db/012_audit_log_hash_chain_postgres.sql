-- Migration 012: audit log hash chain (PostgreSQL)
-- Adds hash chain verification to audit logs.

ALTER TABLE IF EXISTS audit_log ADD COLUMN IF NOT EXISTS prev_hash TEXT;
ALTER TABLE IF EXISTS audit_log ADD COLUMN IF NOT EXISTS hash TEXT;
ALTER TABLE IF EXISTS audit_log ADD COLUMN IF NOT EXISTS event_source TEXT DEFAULT 'admin_action';

CREATE INDEX IF NOT EXISTS idx_audit_log_hash ON audit_log (hash);
