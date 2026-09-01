-- Migration 004: token revocation blocklist
-- Applied automatically by initDb() on startup.

CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti        TEXT    PRIMARY KEY,
  revoked_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at ON revoked_tokens (expires_at);
