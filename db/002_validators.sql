-- Migration 002: validators registry
-- Tracks which Stellar wallets are registered as on-chain validators.
-- Applied automatically by initDb() in src/services/indexer.ts.

CREATE TABLE IF NOT EXISTS validators (
  wallet       TEXT    PRIMARY KEY,
  registered_at INTEGER NOT NULL,
  revoked_at    INTEGER,          -- NULL while active; unix timestamp when revoked
  tx_hash       TEXT              -- hash of the registration / revocation transaction
);

-- Index to quickly list active (non-revoked) validators
CREATE INDEX IF NOT EXISTS idx_validators_revoked ON validators (revoked_at);
