-- Migration 014: Add saved search notifications

ALTER TABLE scout_saved_searches ADD COLUMN notify_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS saved_search_notifications (
  scout_wallet TEXT NOT NULL,
  player_id TEXT NOT NULL,
  notified_at BIGINT NOT NULL,
  PRIMARY KEY (scout_wallet, player_id)
);
