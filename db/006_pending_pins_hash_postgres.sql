-- Migration 006: hash column and unique index for pending_pins dedup mutex (PostgreSQL)
-- Mirrors 006_pending_pins_hash.sql (SQLite) exactly. The previous version of
-- this file added unrelated "hash_chain"/"prev_hash" columns instead of the
-- "hash" column the application actually queries.

ALTER TABLE IF EXISTS pending_pins ADD COLUMN IF NOT EXISTS hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_pins_hash ON pending_pins (hash);
