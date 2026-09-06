-- Migration 029: recreate the composite (type, ledger) index on events.
--
-- Migrations 010/015 created `idx_events_type_ledger` for admin and indexer
-- queries that filter events by `type` and sort by `ledger`. Migration 028
-- (deterministic event ordering) rebuilt the `events` table via
-- CREATE TABLE events_ordered / DROP TABLE events / RENAME, which silently
-- dropped that index without recreating it. Restore it here.
--
-- On the Postgres side migration 028 used ALTER TABLE (no table rebuild), so
-- the index still exists there; IF NOT EXISTS makes this a no-op in that case.

CREATE INDEX IF NOT EXISTS idx_events_type_ledger ON events (type, ledger);
