-- Migration 005: contact unlocks (PostgreSQL)
-- Mirrors 005_contact_unlocks.sql (SQLite). The previous version of this file
-- claimed this table was "already defined in 001_initial_postgres.sql", which
-- was never true — contact_unlocks was never created under DB_DRIVER=postgres.

CREATE TABLE IF NOT EXISTS contact_unlocks (
  scout_wallet TEXT    NOT NULL,
  player_id    TEXT    NOT NULL,
  tx_hash      TEXT    NOT NULL,
  unlocked_at  BIGINT  NOT NULL,
  PRIMARY KEY (scout_wallet, player_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_unlocks_scout ON contact_unlocks (scout_wallet);
