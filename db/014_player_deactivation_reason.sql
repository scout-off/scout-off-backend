-- Migration 014: Add deactivation_reason column to players table
-- Stores the admin-supplied reason when a player is deactivated.

ALTER TABLE players ADD COLUMN deactivation_reason TEXT;
