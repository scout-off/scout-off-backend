-- Migration 024: indexed deterministic lookup hash for API keys (#1033)
--
-- Before this migration, authenticating an X-API-Key request meant loading
-- every non-revoked row from api_keys and re-hashing the presented key against
-- each row's random salt, because key_hash (`salt:sha256(salt+key)`) is
-- deliberately non-deterministic and therefore not searchable. Cost grew
-- linearly with the number of active keys, on the hot path of every request.
--
-- lookup_hash adds a second, *deterministic* representation of the same raw
-- key — HMAC-SHA256(API_KEY_LOOKUP_SECRET, domain || raw_key), stored as
-- `v1:<hex>`; see src/utils/apiKeyLookup.ts — so the candidate row can be
-- found with a single indexed equality lookup, exactly like idempotency_keys
-- (db/003_idempotency_keys.sql) finds a caller-supplied token.
--
-- SECURITY: lookup_hash locates a candidate row; it is NOT the authentication
-- proof. The presented raw key is still verified against key_hash with the
-- existing salted, timing-safe comparison before a request is authenticated.
-- lookup_hash is never returned by any API response.
--
-- BACKFILL: intentionally none. Only a one-way salted hash of each key is
-- stored, so the raw key cannot be recovered and lookup_hash cannot be
-- computed in SQL for pre-existing rows. Those rows keep lookup_hash NULL and
-- are healed lazily: resolveApiKey() falls back to scanning *only* the
-- NULL-lookup_hash rows (idx_api_keys_lookup_pending makes that free once the
-- set is empty) and writes the derived lookup_hash on the first successful
-- authentication. Keys issued before this migration therefore keep working and
-- migrate themselves on first use — no rotation required, and the transitional
-- set shrinks monotonically to zero.

ALTER TABLE api_keys ADD COLUMN lookup_hash TEXT;

-- Primary lookup path. UNIQUE also enforces one row per raw key; multiple
-- NULLs are permitted by both SQLite and PostgreSQL, so not-yet-migrated rows
-- do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_lookup_hash
  ON api_keys (lookup_hash);

-- Transitional path: keeps "are there any un-migrated active keys left?" an
-- indexed probe rather than a table scan. Partial indexes are supported by
-- both SQLite (3.8+) and PostgreSQL. Once every active key has been healed
-- this index is empty and the fallback query returns immediately.
CREATE INDEX IF NOT EXISTS idx_api_keys_lookup_pending
  ON api_keys (id) WHERE lookup_hash IS NULL AND revoked_at IS NULL;
