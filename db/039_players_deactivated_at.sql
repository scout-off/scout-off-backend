-- SQLite never received players.deactivated_at, which PostgreSQL has had since
-- 011_player_deactivation_postgres.sql. Add it so both schemas match and the
-- verified SQLite -> PostgreSQL migration does not report column drift.
ALTER TABLE players ADD COLUMN deactivated_at INTEGER;
