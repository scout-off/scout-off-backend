-- Migration 027: API key per-key rate limits and usage quotas (#1327)
--
-- API keys currently share the per-wallet rate-limit bucket with JWT sessions.
-- A single leaked or misbehaving integration can exhaust a scout's entire session
-- budget, and there is no way to cap or monitor individual key usage.
--
-- This migration adds per-key rate limiting (burst + sustained) and optional monthly quotas.
-- New columns on api_keys:
--   - rate_limit_per_minute: nullable; default null means use global default (unlimited for now)
--   - monthly_quota: nullable; default null means unlimited
--
-- New table api_key_usage tracks cumulative request counts per key per month,
-- using a monthly rolling window (period = YYYY-MM). Requests are counted via
-- Redis INCR with monthly expiry to avoid a DB write per request (issue #675).

ALTER TABLE api_keys ADD COLUMN rate_limit_per_minute INTEGER;
ALTER TABLE api_keys ADD COLUMN monthly_quota INTEGER;

CREATE TABLE IF NOT EXISTS api_key_usage (
  key_id      INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  period      TEXT    NOT NULL,  -- YYYY-MM format for monthly rollover
  request_count INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (key_id, period)
);

CREATE INDEX IF NOT EXISTS idx_api_key_usage_key_id ON api_key_usage (key_id);
