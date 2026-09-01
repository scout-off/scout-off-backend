-- Migration 004: validators table (#290)
-- Tracks admin-registered validators (coaches, academy directors, etc.)
-- Schema matches what src/services/indexer.ts queries. 002_validators.sql
-- already creates this table (and applies first alphabetically), so this
-- migration is a redundant IF NOT EXISTS no-op kept for history/tracking.

CREATE TABLE IF NOT EXISTS validators (
  wallet        TEXT    PRIMARY KEY,
  registered_at INTEGER NOT NULL,
  revoked_at    INTEGER,
  tx_hash       TEXT
);
