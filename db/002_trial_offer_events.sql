-- Migration 002: trial_offer_events table (#285)
-- Persists on-chain trial offer records for queryable history, deduped by
-- tx_hash so replaying the same on-chain event never creates duplicate rows.
--
-- Distinct from the `trial_offers` table (003_subscriptions_and_trial_offers.sql),
-- which tracks the separate scout-offer / player-response workflow keyed by
-- offer_id. This table is the indexer-side event log of on-chain submissions.

CREATE TABLE IF NOT EXISTS trial_offer_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scout_wallet TEXT    NOT NULL,
  player_id    TEXT    NOT NULL,
  details_uri  TEXT    NOT NULL,
  tx_hash      TEXT    NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trial_offer_events_scout ON trial_offer_events (scout_wallet);
CREATE INDEX IF NOT EXISTS idx_trial_offer_events_player ON trial_offer_events (player_id);
