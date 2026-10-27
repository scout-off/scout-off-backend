-- Migration 040: add principal, method, route columns to idempotency_keys (SQLite).
ALTER TABLE idempotency_keys ADD COLUMN principal TEXT;
ALTER TABLE idempotency_keys ADD COLUMN method TEXT;
ALTER TABLE idempotency_keys ADD COLUMN route TEXT;

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_scoped
  ON idempotency_keys (key, expires_at);
