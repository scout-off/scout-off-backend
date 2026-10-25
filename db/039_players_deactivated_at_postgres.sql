-- Already present on PostgreSQL (011_player_deactivation_postgres.sql); kept
-- so the migration pair stays in lockstep with the SQLite file.
ALTER TABLE players ADD COLUMN IF NOT EXISTS deactivated_at BIGINT;
