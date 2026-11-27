-- Migration 040: track issued refresh-token sessions per wallet (PostgreSQL).
-- Mirrors db/040_wallet_token_sessions.sql exactly; timestamp columns are
-- BIGINT because millisecond/second epoch values exceed Postgres's 32-bit
-- INTEGER range (see 004_token_revocation_postgres.sql).

CREATE TABLE IF NOT EXISTS wallet_token_sessions (
  jti           TEXT    PRIMARY KEY,
  wallet        TEXT    NOT NULL,
  issued_at     BIGINT  NOT NULL,
  expires_at    BIGINT  NOT NULL,
  user_agent    TEXT,
  ip_hash       TEXT,
  superseded_at BIGINT,
  revoked_at    BIGINT
);

CREATE INDEX IF NOT EXISTS idx_wallet_token_sessions_wallet ON wallet_token_sessions (wallet);
CREATE INDEX IF NOT EXISTS idx_wallet_token_sessions_expires_at ON wallet_token_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_wallet_token_sessions_superseded ON wallet_token_sessions (superseded_at);

CREATE TABLE IF NOT EXISTS wallet_token_validity (
  wallet            TEXT      PRIMARY KEY,
  tokens_valid_after BIGINT   NOT NULL,
  updated_at        BIGINT   NOT NULL
);
