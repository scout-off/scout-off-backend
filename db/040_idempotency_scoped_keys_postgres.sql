-- Migration 040: add principal, method, route columns to idempotency_keys (PostgreSQL).
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS principal TEXT;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS method TEXT;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS route TEXT;

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_scoped
  ON idempotency_keys (key, expires_at);
