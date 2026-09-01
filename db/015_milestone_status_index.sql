-- Migration 015: composite index for filtered milestone queries
--
-- Supports the ?status= and ?sort= query parameters added to
-- GET /api/players/:playerId/milestones.
--
-- The events table stores both milestone_submitted and milestone_approved
-- rows.  The filtered query pattern is:
--
--   SELECT * FROM events
--   WHERE type = ?            -- equality on 'milestone_submitted'/'milestone_approved'
--     AND payload LIKE ?      -- player_id extracted from JSON payload
--   ORDER BY created_at [ASC|DESC]
--   LIMIT ?
--
-- Column order: (type, created_at) puts the equality predicate first so
-- SQLite uses the index for the WHERE clause, then the ordered created_at
-- column eliminates a separate sort step for the ORDER BY / LIMIT.
-- player_id lives inside the JSON payload so it cannot be indexed here;
-- the type + created_at index is the highest-value addition without adding
-- a generated/virtual column.
--
-- A separate index on (type, created_at) also covers the existing
-- idx_events_type_ledger for queries that sort by ledger, since ledger
-- is monotonically increasing and closely correlated with created_at.

CREATE INDEX IF NOT EXISTS idx_events_type_created_at
    ON events (type, created_at);
