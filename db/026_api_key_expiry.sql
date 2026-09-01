-- Migration 026: API key expiry (#674)
--
-- API keys issued once remain valid indefinitely until manually revoked.
-- For server-to-server credentials embedded in long-lived config or CI
-- secrets, an indefinite lifetime is a liability: a leaked or forgotten key
-- never self-decays.
--
-- expires_at adds an optional (nullable) hard-expiry column: the auth layer
-- rejects any key whose expires_at is set and in the past, with a distinct
-- "expired" error so operators can distinguish expiry from revocation.
--
-- NULL means "no expiry" — explicitly requested for keys that genuinely need
-- to be long-lived. The default at issuance (controlled by the
-- API_KEY_DEFAULT_TTL_DAYS env var, default 90 days) populates a concrete
-- timestamp so keys decay by default without operator action.
--
-- Enforcement is live, same as revoke_after: every active-key query used
-- for authentication checks `expires_at IS NULL OR expires_at > <now>`, so
-- a key past its deadline simply stops resolving with no background sweep.
ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_api_keys_expires_at ON api_keys (expires_at)
  WHERE expires_at IS NOT NULL;
