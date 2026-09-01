-- Migration 026 (PostgreSQL): API key expiry (#674)
-- See db/026_api_key_expiry.sql for the full rationale.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_api_keys_expires_at ON api_keys (expires_at)
  WHERE expires_at IS NOT NULL;
