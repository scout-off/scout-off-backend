-- Migration 030: side table for hash-chained audit_log PII (#1329) — PostgreSQL

CREATE TABLE IF NOT EXISTS audit_log_pii (
  audit_log_id BIGINT PRIMARY KEY REFERENCES audit_log (id) ON DELETE CASCADE,
  pii_json     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_pii_audit_log_id ON audit_log_pii (audit_log_id);
