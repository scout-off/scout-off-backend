-- Migration 003: pending_pins table for IPFS fallback (#346)
CREATE TABLE IF NOT EXISTS pending_pins (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  payload    TEXT    NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  last_tried TEXT
);
