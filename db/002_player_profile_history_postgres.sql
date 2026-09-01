-- Migration 002: player profile metadata history (PostgreSQL)
-- Creates an append-only history table to track metadata_uri updates.

CREATE TABLE IF NOT EXISTS player_profile_history (
  id            SERIAL PRIMARY KEY,
  player_id     TEXT    NOT NULL,
  metadata_uri  TEXT    NOT NULL,
  changed_at    BIGINT  NOT NULL,
  tx_hash       TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_player_profile_history_player_changed_at
  ON player_profile_history (player_id, changed_at DESC);
