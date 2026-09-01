-- Migration 002: trial_offer_events table (PostgreSQL)
-- Persists on-chain trial offer records for queryable history, deduped by
-- tx_hash so replaying the same on-chain event never creates duplicate rows.

CREATE TABLE IF NOT EXISTS trial_offer_events (
  id           SERIAL PRIMARY KEY,
  scout_wallet TEXT    NOT NULL,
  player_id    TEXT    NOT NULL,
  details_uri  TEXT    NOT NULL,
  tx_hash      TEXT    NOT NULL UNIQUE,
  created_at   BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trial_offer_events_scout ON trial_offer_events (scout_wallet);
CREATE INDEX IF NOT EXISTS idx_trial_offer_events_player ON trial_offer_events (player_id);
