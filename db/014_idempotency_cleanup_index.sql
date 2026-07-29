-- Migration 014: add created_at index to idempotency_keys
-- Speeds up the background cleanup job that deletes rows older than 24 hours.

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at ON idempotency_keys (created_at);
