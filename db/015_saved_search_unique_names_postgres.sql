-- Migration 015: unique saved-search names per scout (PostgreSQL) (#1889)
-- Mirrors 015_saved_search_unique_names.sql (SQLite).

UPDATE scout_saved_searches AS target
SET name = target.name || ' (' || (
  SELECT COUNT(*)
  FROM scout_saved_searches AS earlier
  WHERE earlier.scout_wallet = target.scout_wallet
    AND lower(earlier.name) = lower(target.name)
    AND (earlier.created_at < target.created_at
         OR (earlier.created_at = target.created_at
             AND earlier.id < target.id))
) || ')'
WHERE EXISTS (
  SELECT 1
  FROM scout_saved_searches AS earlier
  WHERE earlier.scout_wallet = target.scout_wallet
    AND lower(earlier.name) = lower(target.name)
    AND (earlier.created_at < target.created_at
         OR (earlier.created_at = target.created_at
             AND earlier.id < target.id))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_searches_scout_name
  ON scout_saved_searches (scout_wallet, lower(name));
