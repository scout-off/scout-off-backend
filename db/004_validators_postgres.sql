-- Migration 004: validator tables (PostgreSQL)
-- Additional validator-related tables and indexes.

CREATE TABLE IF NOT EXISTS validator_approvals (
  id                SERIAL PRIMARY KEY,
  milestone_id      TEXT NOT NULL UNIQUE,
  validator_wallet  TEXT NOT NULL,
  approved_at       BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_validator_approvals_milestone ON validator_approvals (milestone_id);
CREATE INDEX IF NOT EXISTS idx_validator_approvals_validator ON validator_approvals (validator_wallet);
