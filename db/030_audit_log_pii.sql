-- Migration 030: side table for hash-chained audit_log PII (#1329)
--
-- audit_log rows are append-only and hash-chained; mutating query_params would
-- break the chain. Optional PII that must be retained separately for operational
-- needs is stored here and can be deleted on GDPR anonymization without touching
-- audit_log.

CREATE TABLE IF NOT EXISTS audit_log_pii (
  audit_log_id INTEGER PRIMARY KEY,
  pii_json     TEXT NOT NULL,
  FOREIGN KEY (audit_log_id) REFERENCES audit_log (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_log_pii_audit_log_id ON audit_log_pii (audit_log_id);
