-- Migration 012: webhook subscriptions (PostgreSQL)
-- Manages webhook endpoint subscriptions.

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id        SERIAL PRIMARY KEY,
  url       TEXT NOT NULL UNIQUE,
  secret    TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_url ON webhook_subscriptions (url);
