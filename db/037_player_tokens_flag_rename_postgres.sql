-- Migration 037: unify the Player Tokens feature flag on `player_tokens_enabled` (#1515). (PostgreSQL)
-- Carries any legacy `player_tokens` value over to the seeded row, then drops it.

INSERT INTO feature_flags (name, enabled, updated_at, updated_by)
VALUES ('player_tokens_enabled', 0, 0, 'system')
ON CONFLICT (name) DO NOTHING;

UPDATE feature_flags
SET enabled = (SELECT enabled FROM feature_flags WHERE name = 'player_tokens'),
    updated_at = (SELECT updated_at FROM feature_flags WHERE name = 'player_tokens'),
    updated_by = (SELECT updated_by FROM feature_flags WHERE name = 'player_tokens')
WHERE name = 'player_tokens_enabled'
  AND EXISTS (SELECT 1 FROM feature_flags WHERE name = 'player_tokens');

DELETE FROM feature_flags WHERE name = 'player_tokens';
