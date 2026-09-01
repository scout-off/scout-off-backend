-- Migration 011: Add soft-delete / deactivation flag to players table

ALTER TABLE players ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_players_is_active ON players (is_active);
