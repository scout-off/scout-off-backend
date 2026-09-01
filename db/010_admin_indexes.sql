-- Migration 010: add composite indexes to optimize admin aggregation and query performance

-- Create missing base tables first if they are not already created by initDb()
CREATE TABLE IF NOT EXISTS validator_stats (
  wallet             TEXT PRIMARY KEY,
  milestones_approved INTEGER DEFAULT 0,
  milestones_rejected INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pending_milestones (
  milestone_id    TEXT PRIMARY KEY,
  player_id       TEXT NOT NULL,
  validator_wallet TEXT NOT NULL,
  milestone_type  TEXT NOT NULL,
  evidence_uri    TEXT NOT NULL,
  submitted_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_milestones_validator ON pending_milestones (validator_wallet);
CREATE INDEX IF NOT EXISTS idx_pending_milestones_player ON pending_milestones (player_id);

-- New composite indexes for query optimization
CREATE INDEX IF NOT EXISTS idx_events_type_ledger ON events (type, ledger);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_scout_cancelled_expires ON subscriptions (scout_wallet, cancelled_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_action_created_at ON audit_log (action, created_at);
CREATE INDEX IF NOT EXISTS idx_pending_milestones_validator_submitted_at ON pending_milestones (validator_wallet, submitted_at);
