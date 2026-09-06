-- Migration 004: webhook delivery history table (PostgreSQL)
-- Tracks every webhook dispatch attempt (success or failure) for operator debugging.
--
-- Dedicated counterpart because the base file's
-- `DEFAULT (strftime('%s', 'now') * 1000)` is SQLite-only; Postgres uses an
-- epoch-millis expression instead (convertSqlToPostgres() does not translate it).

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              SERIAL  PRIMARY KEY,
  subscription_id TEXT    NOT NULL,
  event_type      TEXT    NOT NULL,
  delivery_id     TEXT    NOT NULL UNIQUE,
  attempt_count   INTEGER NOT NULL DEFAULT 1,
  status          TEXT    NOT NULL,
  status_code     INTEGER,
  error_message   TEXT,
  latency_ms      INTEGER,
  created_at      BIGINT  NOT NULL DEFAULT (extract(epoch from now()) * 1000)::bigint
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription
  ON webhook_deliveries (subscription_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created_at
  ON webhook_deliveries (created_at);
