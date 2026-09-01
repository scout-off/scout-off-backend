-- Migration: webhook delivery history table
-- Tracks every webhook dispatch attempt (success or failure) for operator debugging.

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  subscription_id TEXT    NOT NULL,          -- webhook subscription identifier (URL used as key)
  event_type      TEXT    NOT NULL,
  delivery_id     TEXT    NOT NULL UNIQUE,   -- uuid v4 or similar, generated per dispatch
  attempt_count   INTEGER NOT NULL DEFAULT 1,
  status          TEXT    NOT NULL,          -- 'success' | 'failure'
  status_code     INTEGER,                   -- HTTP response status code (null on network error)
  error_message   TEXT,                      -- error detail on failure
  latency_ms      INTEGER,                   -- round-trip latency in milliseconds
  created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription
  ON webhook_deliveries (subscription_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at
  ON webhook_deliveries (created_at);
