-- Migration 018: scout_player_notes_v2 table (PostgreSQL)
-- Multi-note CRUD for private scout observations on players.

CREATE TABLE IF NOT EXISTS scout_player_notes_v2 (
  id           SERIAL  PRIMARY KEY,
  scout_wallet TEXT    NOT NULL,
  player_id    TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  created_at   BIGINT  NOT NULL,
  updated_at   BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spn_v2_scout_player
  ON scout_player_notes_v2 (scout_wallet, player_id);
