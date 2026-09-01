-- Migration 009: saved searches (PostgreSQL)
-- Mirrors 009_saved_searches.sql (SQLite) exactly. The previous version of
-- this file created a table named "saved_searches" — the application only
-- ever queries "scout_saved_searches" — and added a UNIQUE(scout_wallet,
-- name) constraint the SQLite schema doesn't have, which would have made
-- Postgres reject saved searches SQLite happily allows.

CREATE TABLE IF NOT EXISTS scout_saved_searches (
  id           SERIAL PRIMARY KEY,
  scout_wallet TEXT   NOT NULL,
  name         TEXT   NOT NULL,
  filters      TEXT   NOT NULL,  -- JSON: { region?, position?, minTier? }
  created_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_saved_searches_scout ON scout_saved_searches (scout_wallet);
