-- Migration 018: scout_player_notes_v2 table
-- Multi-note CRUD for private scout observations on players.
-- Unlike scout_player_notes (which enforces one note per scout+player pair),
-- this table allows scouts to keep multiple notes per player.
-- Notes are strictly private and never exposed via admin or player-facing endpoints.

CREATE TABLE IF NOT EXISTS scout_player_notes_v2 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scout_wallet TEXT    NOT NULL,
  player_id    TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spn_v2_scout_player
  ON scout_player_notes_v2 (scout_wallet, player_id);
