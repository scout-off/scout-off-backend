-- Migration 001: initial schema (PostgreSQL)
-- Applied automatically by runMigrations() (src/db/migrate.ts) on startup.
-- This file is the PostgreSQL equivalent of 001_initial.sql

CREATE TABLE IF NOT EXISTS events (
  id        SERIAL PRIMARY KEY,
  type      TEXT    NOT NULL,
  ledger    INTEGER NOT NULL,
  tx_hash   TEXT    NOT NULL UNIQUE,
  payload   TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS indexer_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_events_type   ON events (type);
CREATE INDEX IF NOT EXISTS idx_events_ledger ON events (ledger);

CREATE TABLE IF NOT EXISTS players (
  player_id      TEXT    PRIMARY KEY,
  wallet         TEXT    NOT NULL,
  position       TEXT,
  region         TEXT,
  metadata_uri   TEXT,
  progress_level INTEGER DEFAULT 0,
  created_at     BIGINT,
  is_active      INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_players_region   ON players (region);
CREATE INDEX IF NOT EXISTS idx_players_position ON players (position);
CREATE INDEX IF NOT EXISTS idx_players_tier     ON players (progress_level);
