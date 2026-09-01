-- Migration 003: subscriptions table (PostgreSQL)
-- Tracks per-scout subscription state locally (renewal, cancellation).

CREATE TABLE IF NOT EXISTS subscriptions (
  id           SERIAL PRIMARY KEY,
  scout_wallet TEXT    NOT NULL,
  tier         TEXT    NOT NULL,
  expires_at   BIGINT  NOT NULL,
  cancelled_at BIGINT,
  created_at   BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_scout ON subscriptions (scout_wallet);
