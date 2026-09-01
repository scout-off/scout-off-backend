-- Migration 002: audit log table (#345)
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  action       TEXT    NOT NULL,
  admin_wallet TEXT    NOT NULL,
  query_params TEXT    NOT NULL DEFAULT '{}',
  created_at   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_action     ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_log (created_at);
