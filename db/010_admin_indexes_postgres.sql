-- Migration 010: admin indexes (PostgreSQL)
-- Performance indexes for admin queries, plus the validator_stats/
-- pending_milestones base tables — mirrors 010_admin_indexes.sql (SQLite),
-- which creates these same tables as a fallback in case they weren't created
-- elsewhere. Under DB_DRIVER=postgres they were never created at all (the
-- inline bootstrap schema in initDb() only runs for SQLite), so every
-- validator-stats/pending-milestone query failed with "relation does not
-- exist".

CREATE TABLE IF NOT EXISTS validator_stats (
  wallet               TEXT PRIMARY KEY,
  milestones_approved  INTEGER DEFAULT 0,
  milestones_rejected  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pending_milestones (
  milestone_id     TEXT PRIMARY KEY,
  player_id        TEXT NOT NULL,
  validator_wallet TEXT NOT NULL,
  milestone_type   TEXT NOT NULL,
  evidence_uri     TEXT NOT NULL,
  submitted_at     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_milestones_validator ON pending_milestones (validator_wallet);
CREATE INDEX IF NOT EXISTS idx_pending_milestones_player ON pending_milestones (player_id);
CREATE INDEX IF NOT EXISTS idx_pending_milestones_validator_submitted_at ON pending_milestones (validator_wallet, submitted_at);

-- idx_events_created_at intentionally omitted: the events table (owned by the
-- event-indexing subsystem, out of scope here) has no created_at column
-- under PostgreSQL, so this index — present in earlier drafts of this file —
-- referenced a nonexistent column and made every PostgreSQL migration run
-- fail at startup.
CREATE INDEX IF NOT EXISTS idx_players_created_at ON players (created_at);
CREATE INDEX IF NOT EXISTS idx_subscriptions_created_at ON subscriptions (created_at);
