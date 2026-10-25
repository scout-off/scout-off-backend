CREATE TABLE IF NOT EXISTS profile_view_daily (
  player_id TEXT NOT NULL,
  scout_wallet TEXT NOT NULL,
  day BIGINT NOT NULL,
  view_count BIGINT NOT NULL,
  PRIMARY KEY (player_id, scout_wallet, day)
);
CREATE TABLE IF NOT EXISTS audit_checkpoints (
  last_id BIGINT PRIMARY KEY,
  last_hash TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  archive_file TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  signature TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_retention_profile_views ON profile_views(viewed_at, id);
CREATE INDEX IF NOT EXISTS idx_retention_idempotency ON idempotency_keys(expires_at);
CREATE INDEX IF NOT EXISTS idx_retention_export_jobs ON data_export_jobs(expires_at);
CREATE INDEX IF NOT EXISTS idx_retention_events ON events(created_at, id);
CREATE INDEX IF NOT EXISTS idx_retention_dead_letters ON webhook_dead_letters(created_at, id);
