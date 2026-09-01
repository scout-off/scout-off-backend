-- Migration 013: webhook dead-letter queue (PostgreSQL) (#470, #1018)
--
-- Stores failed webhook delivery attempts. Schema is kept in parity with the
-- SQLite version (db/013_webhook_dead_letters.sql) so the same test suite
-- exercises both drivers.
--
-- Columns:
--   delivery_id     — stable, unique identifier for the logical delivery.
--                     Generated once at first dispatch, carried through to every
--                     dead-letter replay so subscribers can deduplicate.
--   locked_by       — claims a row for a single concurrent retry sweep.
--                     Atomic UPDATE ... WHERE locked_by IS NULL ensures at most
--                     one in-flight worker per row (#1018).
--   locked_at       — timestamp when the row was claimed; used to detect stale
--                     locks left by crashed workers.

CREATE TABLE IF NOT EXISTS webhook_dead_letters (
  id                SERIAL PRIMARY KEY,
  subscription_id   INTEGER,
  url               TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  payload           TEXT NOT NULL,
  delivery_id       TEXT NOT NULL,
  failure_reason    TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'in_progress' | 'replayed'
  locked_by         TEXT,
  locked_at         TEXT,
  created_at        TEXT NOT NULL DEFAULT (NOW() AT TIME ZONE 'utc'),
  replayed_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_dead_letters_status ON webhook_dead_letters (status);
CREATE INDEX IF NOT EXISTS idx_webhook_dead_letters_delivery_id ON webhook_dead_letters (delivery_id);
CREATE INDEX IF NOT EXISTS idx_webhook_dead_letters_subscription ON webhook_dead_letters (subscription_id);
