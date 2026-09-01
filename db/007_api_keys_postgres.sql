-- Migration 007: api_keys table (#490) (PostgreSQL)
-- Long-lived API keys for server-to-server scout integrations.
-- Only a salted hash of each key is stored; the plaintext is returned exactly once at issuance.

CREATE TABLE IF NOT EXISTS api_keys (
  id           SERIAL PRIMARY KEY,
  key_hash     TEXT    NOT NULL UNIQUE,
  scout_wallet TEXT    NOT NULL,
  label        TEXT    NOT NULL DEFAULT '',
  created_at   BIGINT  NOT NULL,
  last_used_at BIGINT,
  revoked_at   BIGINT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_scout  ON api_keys (scout_wallet);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash   ON api_keys (key_hash);
