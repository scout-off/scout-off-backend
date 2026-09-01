-- Migration 009: scout_saved_searches table (#486)
-- Per-scout named filter presets. The filter payload is stored as validated JSON
-- so re-running a saved search always goes through the same query-building path
-- as a live filter request.

CREATE TABLE IF NOT EXISTS scout_saved_searches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scout_wallet TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  filters      TEXT    NOT NULL,  -- JSON: { region?, position?, minTier? }
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saved_searches_scout ON scout_saved_searches (scout_wallet);
