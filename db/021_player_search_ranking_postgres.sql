-- Migration 021: Player search ranking, registered_at column, cursor pagination
-- Adds registered_at for consistent time-based ordering and search indexes.

ALTER TABLE players ADD COLUMN IF NOT EXISTS registered_at BIGINT;

-- Backfill: HTTP-registered rows (created_at > 10B = Unix seconds)
UPDATE players SET registered_at = created_at * 1000 WHERE created_at > 10000000000;

-- Unlike the SQLite version, there is no indexer-created-rows backfill step
-- here: the event indexer (src/services/indexer.ts) is a separate,
-- out-of-scope subsystem that talks to the events table exclusively through
-- the raw synchronous SQLite handle (getDb()), so it cannot run at all under
-- DB_DRIVER=postgres — the events table stays permanently empty on a
-- PostgreSQL deployment, and player rows only ever arrive via the
-- HTTP/API-key registration path already backfilled above. A query joining
-- against events here would just be dead code (and events.created_at
-- doesn't even exist under PostgreSQL — see 010_admin_indexes_postgres.sql).

-- Remaining rows default to 0
UPDATE players SET registered_at = 0 WHERE registered_at IS NULL;

ALTER TABLE players ALTER COLUMN registered_at SET NOT NULL;
ALTER TABLE players ALTER COLUMN registered_at SET DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_players_registered_at ON players (registered_at);
CREATE INDEX IF NOT EXISTS idx_players_search ON players (region, position, progress_level, registered_at);
