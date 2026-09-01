-- Migration 011: player deactivation (PostgreSQL)
-- Adds deactivation support to players table.

ALTER TABLE IF EXISTS players ADD COLUMN IF NOT EXISTS is_active INTEGER DEFAULT 1;
ALTER TABLE IF EXISTS players ADD COLUMN IF NOT EXISTS deactivated_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_players_is_active ON players (is_active);
