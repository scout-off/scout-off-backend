-- Migration 007: api_keys table (#490)
-- Long-lived API keys for server-to-server scout integrations.
-- Only a salted hash of each key is stored; the plaintext is returned exactly once at issuance.

CREATE TABLE IF NOT EXISTS api_keys (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash     TEXT    NOT NULL UNIQUE,
  scout_wallet TEXT    NOT NULL,
  label        TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_api_keys_scout  ON api_keys (scout_wallet);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash   ON api_keys (key_hash);
