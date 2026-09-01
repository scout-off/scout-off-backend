-- Migration 002: audit log table (PostgreSQL)
-- Mirrors 002_audit_log.sql (SQLite). No PostgreSQL counterpart existed
-- previously, so the audit_log table itself — and everything layered on top
-- of it (012_audit_log_hash_chain, logAuditEvent, recordAudit/queryAudit,
-- verifyAuditChain) — could never be created under DB_DRIVER=postgres.

CREATE TABLE IF NOT EXISTS audit_log (
  id           SERIAL PRIMARY KEY,
  action       TEXT    NOT NULL,
  admin_wallet TEXT    NOT NULL,
  query_params TEXT    NOT NULL DEFAULT '{}',
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_action     ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log (created_at);
