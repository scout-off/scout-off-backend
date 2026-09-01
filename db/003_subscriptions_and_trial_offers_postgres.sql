-- Migration 003: subscriptions and trial offers (PostgreSQL)
-- Mirrors 003_subscriptions_and_trial_offers.sql (SQLite) exactly. The
-- previous version of this file defined trial_offers with an entirely
-- different column set (state/expires_at instead of offer_id/details_uri/
-- status/reject_reason), so every trial-offer query failed under
-- DB_DRIVER=postgres — either "column does not exist" or silently querying
-- the wrong shape.

CREATE TABLE IF NOT EXISTS trial_offers (
  id            SERIAL PRIMARY KEY,
  offer_id      TEXT    NOT NULL UNIQUE,
  scout_wallet  TEXT    NOT NULL,
  player_id     TEXT    NOT NULL,
  details_uri   TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending',
  reject_reason TEXT,
  responded_at  BIGINT,
  created_at    BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trial_offers_player ON trial_offers (player_id);
CREATE INDEX IF NOT EXISTS idx_trial_offers_scout  ON trial_offers (scout_wallet);
