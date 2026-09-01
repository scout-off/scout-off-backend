-- Migration 005: contact_unlocks table (#284)
-- Persistent record of scout-player contact unlock events.

CREATE TABLE IF NOT EXISTS contact_unlocks (
  scout_wallet TEXT    NOT NULL,
  player_id    TEXT    NOT NULL,
  tx_hash      TEXT    NOT NULL,
  unlocked_at  INTEGER NOT NULL,
  PRIMARY KEY (scout_wallet, player_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_unlocks_scout ON contact_unlocks (scout_wallet);
