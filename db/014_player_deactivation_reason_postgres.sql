-- Migration 014: Add deactivation_reason column to players table (PostgreSQL)
-- Stores the admin-supplied reason when a player is deactivated.

ALTER TABLE players ADD COLUMN IF NOT EXISTS deactivation_reason TEXT;
