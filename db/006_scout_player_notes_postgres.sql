-- Migration 006: scout player notes (PostgreSQL)
-- Mirrors 006_scout_player_notes.sql (SQLite) exactly. The previous version of
-- this file used column name "note" (application code queries "note_text")
-- and required a "created_at" column the application never writes — both of
-- which made every scout-notes query fail under DB_DRIVER=postgres.

CREATE TABLE IF NOT EXISTS scout_player_notes (
  id           SERIAL PRIMARY KEY,
  scout_wallet TEXT   NOT NULL,
  player_id    TEXT   NOT NULL,
  note_text    TEXT   NOT NULL,
  updated_at   BIGINT NOT NULL,
  UNIQUE (scout_wallet, player_id)
);

CREATE INDEX IF NOT EXISTS idx_scout_player_notes_scout ON scout_player_notes (scout_wallet);
CREATE INDEX IF NOT EXISTS idx_scout_player_notes_player ON scout_player_notes (player_id);
