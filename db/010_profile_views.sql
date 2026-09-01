-- Migration 010: profile_views table
-- Persistent record of scout profile views with deduplication window tracking.
-- Scouts viewing player profiles generate records here for analytics aggregation.
-- Deduplication logic prevents artificial inflation from rapid repeated views (5-minute window).

CREATE TABLE IF NOT EXISTS profile_views (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  scout_wallet  TEXT    NOT NULL,
  player_id     TEXT    NOT NULL,
  viewed_at     INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

-- Index for dedup queries: find most recent view from scout for player
-- Also optimizes analytics aggregations by player and unique scouts
CREATE INDEX IF NOT EXISTS idx_profile_views_dedup
  ON profile_views (player_id, scout_wallet, viewed_at DESC);

-- Index for analytics queries that aggregate all views for a single player
CREATE INDEX IF NOT EXISTS idx_profile_views_player
  ON profile_views (player_id);
