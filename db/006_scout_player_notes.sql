-- Migration 006: scout_player_notes table (#488)
-- Private per-scout notes on player profiles.
-- Notes are strictly private: never exposed via admin, export, or player-facing endpoints.

CREATE TABLE IF NOT EXISTS scout_player_notes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scout_wallet TEXT    NOT NULL,
  player_id    TEXT    NOT NULL,
  note_text    TEXT    NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (scout_wallet, player_id)
);

CREATE INDEX IF NOT EXISTS idx_scout_player_notes_scout ON scout_player_notes (scout_wallet);
CREATE INDEX IF NOT EXISTS idx_scout_player_notes_player ON scout_player_notes (player_id);
