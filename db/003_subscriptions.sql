-- Migration 003: subscriptions table
-- Tracks per-scout subscription state locally (renewal, cancellation).
-- Schema matches what src/services/indexer.ts queries; kept as its own file
-- (rather than folded into 003_subscriptions_and_trial_offers.sql) so it
-- always sorts and applies before that migration's redundant IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS subscriptions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scout_wallet TEXT    NOT NULL,
  tier         TEXT    NOT NULL,
  expires_at   INTEGER NOT NULL,
  cancelled_at INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_scout ON subscriptions (scout_wallet);
