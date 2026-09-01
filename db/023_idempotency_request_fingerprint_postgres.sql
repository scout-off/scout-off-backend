-- Migration 023: request fingerprint column on idempotency_keys (PostgreSQL).
--
-- Stores a fingerprint of the originating request (e.g. wallet + playerId for
-- POST /scouts/:wallet/contacts/:playerId/unlock) so a replayed idempotency
-- key that arrives with materially different request parameters can be
-- rejected with 409 instead of serving the cached response of an unrelated
-- request (Issue #761).
--
-- Nullable: endpoints that use the middleware without a request fingerprint
-- (e.g. subscribe) leave it NULL and keep the legacy key-only behaviour.

ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;