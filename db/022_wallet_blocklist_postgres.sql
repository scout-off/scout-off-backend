-- Migration 022: wallet blocklist (PostgreSQL) (#1019)
-- Persisted blocklist for wallets whose SSE access is revoked (see
-- docs/auth.md "SSE live revocation").

CREATE TABLE IF NOT EXISTS wallet_blocklist (
  wallet     TEXT    PRIMARY KEY,
  reason     TEXT,
  blocked_at BIGINT  NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallet_blocklist_blocked_at ON wallet_blocklist (blocked_at);