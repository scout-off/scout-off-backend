-- Migration 027 (PostgreSQL): API key per-key rate limits and usage quotas (#1327)
--
-- Postgres twin of 027_api_key_rate_limits.sql. See the base migration for
-- the full description.
--
-- api_keys.id is SERIAL (see 007_api_keys_postgres.sql), so key_id uses
-- INTEGER to match. created_at/updated_at use BIGINT for epoch-millisecond
-- timestamps, consistent with the other Postgres migrations.
--
-- The index on api_key_usage(key_id) is redundant with the PRIMARY KEY's
-- leading column, but it is kept for parity with the SQLite migration so
-- both dialects expose the same index name (idx_api_key_usage_key_id).

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS monthly_quota INTEGER;

CREATE TABLE IF NOT EXISTS api_key_usage (
  key_id        INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  period        TEXT    NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  created_at    BIGINT  NOT NULL,
  updated_at    BIGINT  NOT NULL,
  PRIMARY KEY (key_id, period)
);

CREATE INDEX IF NOT EXISTS idx_api_key_usage_key_id ON api_key_usage (key_id);
