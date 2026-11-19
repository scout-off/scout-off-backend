-- Migration 015: unique saved-search names per scout (#1889)
-- De-duplicates existing rows case-insensitively per scout (appending (2), (3),
-- ... ordered by created_at, then id) before creating the unique index.

UPDATE scout_saved_searches
SET name = name || ' (' || (
  SELECT COUNT(*)
  FROM scout_saved_searches AS earlier
  WHERE earlier.scout_wallet = scout_saved_searches.scout_wallet
    AND lower(earlier.name) = lower(scout_saved_searches.name)
    AND (earlier.created_at < scout_saved_searches.created_at
         OR (earlier.created_at = scout_saved_searches.created_at
             AND earlier.id < scout_saved_searches.id))
) || ')'
WHERE (
  SELECT COUNT(*)
  FROM scout_saved_searches AS earlier
  WHERE earlier.scout_wallet = scout_saved_searches.scout_wallet
    AND lower(earlier.name) = lower(scout_saved_searches.name)
    AND (earlier.created_at < scout_saved_searches.created_at
         OR (earlier.created_at = scout_saved_searches.created_at
             AND earlier.id < scout_saved_searches.id))
) > 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_searches_scout_name
  ON scout_saved_searches (scout_wallet, lower(name));
