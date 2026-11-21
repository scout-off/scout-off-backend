-- Migration 040: track issued refresh-token sessions per wallet.
-- Wallet-scoped refresh-token session metadata (jti, issuedAt, expiresAt,
-- userAgent/IP hash) is recorded at issue time so an admin can enumerate and
-- revoke every active session for a wallet (see walletTokenSessions.ts).
-- wallet_token_validity stores a per-wallet tokens_valid_after cutoff: access
-- tokens issued at or before it are rejected by requireAuth even before they
-- expire, used by the revoke-all path.

CREATE TABLE IF NOT EXISTS wallet_token_sessions (
  jti          TEXT    PRIMARY KEY,
  wallet       TEXT    NOT NULL,
  issued_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT,
  ip_hash      TEXT,
  superseded_at INTEGER,
  revoked_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_wallet_token_sessions_wallet ON wallet_token_sessions (wallet);
CREATE INDEX IF NOT EXISTS idx_wallet_token_sessions_expires_at ON wallet_token_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_wallet_token_sessions_superseded ON wallet_token_sessions (superseded_at);

CREATE TABLE IF NOT EXISTS wallet_token_validity (
  wallet            TEXT    PRIMARY KEY,
  tokens_valid_after INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
