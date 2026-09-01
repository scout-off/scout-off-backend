-- Migration 003: pending_pins table (PostgreSQL)
-- Mirrors 003_pending_pins.sql (SQLite) exactly. The previous version of this
-- file defined an unrelated schema (hash/uri columns, no payload/last_tried)
-- that didn't match any query the application issues.

CREATE TABLE IF NOT EXISTS pending_pins (
  id         SERIAL PRIMARY KEY,
  payload    TEXT    NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  last_tried TEXT
);
