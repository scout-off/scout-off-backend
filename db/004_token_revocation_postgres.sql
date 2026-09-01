-- Migration 004: token revocation list (PostgreSQL)
-- Tracks revoked authentication tokens to prevent reuse.
--
-- Column is `jti` (the JWT ID claim), matching 004_token_revocation.sql
-- (SQLite) exactly — src/services/tokenBlocklist.ts's SQL (writeToDb,
-- checkDb, pruneExpiredTokens, syncDbToRedis) references `jti` everywhere
-- and is shared verbatim across both drivers. This file previously used
-- `token_hash`, a stale column name from before tokenBlocklist.ts was
-- written — every DB-fallback write/read against PostgreSQL failed outright
-- with "column jti does not exist".

CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti           TEXT PRIMARY KEY,
  revoked_at    BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at ON revoked_tokens (expires_at);
