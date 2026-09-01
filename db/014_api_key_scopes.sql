-- Migration 014: API key scopes and rate limits
-- Adds per-key permission scopes and rate limiting to the api_keys table.

-- Add scopes and rate_limit_per_minute columns
ALTER TABLE api_keys ADD COLUMN scopes TEXT DEFAULT '["read:players","read:milestones","write:contacts","read:subscription"]';
ALTER TABLE api_keys ADD COLUMN rate_limit_per_minute INTEGER DEFAULT 60;

-- Create index for rate limit lookups
CREATE INDEX IF NOT EXISTS idx_api_keys_rate_limit ON api_keys (id, rate_limit_per_minute) WHERE revoked_at IS NULL;