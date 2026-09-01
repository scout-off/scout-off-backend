-- Migration 022: wallet blocklist (#1019)
-- Wallets listed here are denied new SSE connections and have their
-- established SSE connections terminated (bounded detection, see
-- docs/auth.md "SSE live revocation").
-- Mirrors the token revocation blocklist pattern: the DB is the durable
-- store; services keep an in-memory cache refreshed on a bounded interval.

CREATE TABLE IF NOT EXISTS wallet_blocklist (
  wallet     TEXT    PRIMARY KEY,
  reason     TEXT,
  blocked_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wallet_blocklist_blocked_at ON wallet_blocklist (blocked_at);