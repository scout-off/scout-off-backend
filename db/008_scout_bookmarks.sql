-- Migration 008: scout_bookmarks table (#487)
-- Per-scout player bookmark list. Unique on (scout_wallet, player_id) to prevent duplicates.
-- Supports folder-based organization and optional notes.

CREATE TABLE IF NOT EXISTS scout_bookmark_folders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scout_wallet TEXT    NOT NULL,
  name         TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  UNIQUE (scout_wallet, name)
);

CREATE INDEX IF NOT EXISTS idx_scout_bookmark_folders_scout ON scout_bookmark_folders (scout_wallet);

CREATE TABLE IF NOT EXISTS scout_bookmarks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scout_wallet TEXT    NOT NULL,
  player_id    TEXT    NOT NULL,
  folder_id    INTEGER,
  note         TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE (scout_wallet, player_id),
  FOREIGN KEY (folder_id) REFERENCES scout_bookmark_folders(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_scout_bookmarks_scout    ON scout_bookmarks (scout_wallet);
CREATE INDEX IF NOT EXISTS idx_scout_bookmarks_player   ON scout_bookmarks (player_id);
CREATE INDEX IF NOT EXISTS idx_scout_bookmarks_folder   ON scout_bookmarks (folder_id);
