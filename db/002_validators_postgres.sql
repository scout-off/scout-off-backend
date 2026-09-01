-- Migration 002: validators registry (PostgreSQL)
-- Tracks which Stellar wallets are registered as on-chain validators.

CREATE TABLE IF NOT EXISTS validators (
  wallet       TEXT    PRIMARY KEY,
  registered_at BIGINT NOT NULL,
  revoked_at    BIGINT,          -- NULL while active; unix timestamp when revoked
  tx_hash       TEXT              -- hash of the registration / revocation transaction
);

-- Index to quickly list active (non-revoked) validators
CREATE INDEX IF NOT EXISTS idx_validators_revoked ON validators (revoked_at);
