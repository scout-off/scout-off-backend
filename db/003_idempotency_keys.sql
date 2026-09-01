-- Migration 003: idempotency keys for safe subscription retries
-- Stores the idempotency key, its cached response, and expiry time.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          TEXT    PRIMARY KEY,
  status_code  INTEGER NOT NULL,
  response     TEXT    NOT NULL,  -- JSON-serialised response body
  created_at   INTEGER NOT NULL,  -- Unix timestamp (ms)
  expires_at   INTEGER NOT NULL   -- Unix timestamp (ms); TTL = 24 h
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires_at
  ON idempotency_keys (expires_at);
