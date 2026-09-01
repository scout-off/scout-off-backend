-- Migration 003: subscriptions table and trial_offers table
-- subscriptions: tracks per-scout subscription state locally (renewal, cancellation)
-- trial_offers: tracks per-offer accept/reject responses from players

CREATE TABLE IF NOT EXISTS subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scout_wallet TEXT   NOT NULL,
  tier        TEXT    NOT NULL,
  expires_at  INTEGER NOT NULL,
  cancelled_at INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_scout ON subscriptions (scout_wallet);

CREATE TABLE IF NOT EXISTS trial_offers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id     TEXT    NOT NULL UNIQUE,
  scout_wallet TEXT    NOT NULL,
  player_id    TEXT    NOT NULL,
  details_uri  TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  responded_at INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trial_offers_player ON trial_offers (player_id);
CREATE INDEX IF NOT EXISTS idx_trial_offers_scout  ON trial_offers (scout_wallet);
