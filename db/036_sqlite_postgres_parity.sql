-- SQLite previously omitted the PostgreSQL validator-approval archive.
-- Keep historical migration files intact so their recorded checksums remain valid.
CREATE TABLE IF NOT EXISTS validator_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id TEXT NOT NULL UNIQUE,
  validator_wallet TEXT NOT NULL,
  approved_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_validator_approvals_milestone ON validator_approvals(milestone_id);
CREATE INDEX IF NOT EXISTS idx_validator_approvals_validator ON validator_approvals(validator_wallet);
-- Preserve the extra PostgreSQL metadata column without discarding existing
-- values there. Existing SQLite subscriptions have no update timestamp.
ALTER TABLE webhook_subscriptions ADD COLUMN updated_at INTEGER;
