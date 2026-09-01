-- Migration 008: scout bookmarks (PostgreSQL)
-- Stores bookmarked players per scout with folder organization and notes.

CREATE TABLE IF NOT EXISTS scout_bookmark_folders (
  id            SERIAL PRIMARY KEY,
  scout_wallet  TEXT NOT NULL,
  name          TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  UNIQUE(scout_wallet, name)
);

CREATE INDEX IF NOT EXISTS idx_scout_bookmark_folders_scout ON scout_bookmark_folders (scout_wallet);

CREATE TABLE IF NOT EXISTS scout_bookmarks (
  id            SERIAL PRIMARY KEY,
  scout_wallet  TEXT NOT NULL,
  player_id     TEXT NOT NULL,
  folder_id     INTEGER REFERENCES scout_bookmark_folders(id) ON DELETE SET NULL,
  note          TEXT,
  created_at    BIGINT NOT NULL,
  UNIQUE(scout_wallet, player_id)
);

CREATE INDEX IF NOT EXISTS idx_scout_bookmarks_scout   ON scout_bookmarks (scout_wallet);
CREATE INDEX IF NOT EXISTS idx_scout_bookmarks_player  ON scout_bookmarks (player_id);
CREATE INDEX IF NOT EXISTS idx_scout_bookmarks_folder  ON scout_bookmarks (folder_id);
