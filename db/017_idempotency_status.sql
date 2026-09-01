-- Migration 017: add status column to idempotency_keys table.
--
-- 'pending'  — key has been claimed; the originating request is still in-flight.
-- 'complete' — the response has been persisted; safe to serve from cache.
--
-- All existing rows (created before this migration) are treated as complete.

ALTER TABLE idempotency_keys ADD COLUMN status TEXT NOT NULL DEFAULT 'complete';
