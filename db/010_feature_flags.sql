-- Migration 010: runtime feature flags (#494)
-- Boolean flags toggled via admin API without redeploying.

CREATE TABLE IF NOT EXISTS feature_flags (
  name       TEXT    PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT    NOT NULL
);

-- Seed the saved-searches flag enabled so existing behaviour is unchanged.
INSERT OR IGNORE INTO feature_flags (name, enabled, updated_at, updated_by)
VALUES ('saved_searches', 1, 0, 'system');
