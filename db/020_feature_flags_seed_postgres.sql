-- Migration 020: seed additional runtime feature flags (#805, PostgreSQL)
--
-- Mirrors db/020_feature_flags_seed.sql's columns exactly (name, enabled,
-- updated_at, updated_by) — feature_flags has no created_at column (see
-- 010_feature_flags_postgres.sql). `enabled` is INTEGER (0/1), not a native
-- BOOLEAN (same reasoning as 010_feature_flags_postgres.sql), so TRUE/FALSE
-- literals are not valid here — Postgres has no implicit boolean-to-integer
-- assignment cast.

INSERT INTO feature_flags (name, enabled, updated_at, updated_by)
VALUES ('player_tokens_enabled',       0, 0, 'system')
ON CONFLICT (name) DO NOTHING;

INSERT INTO feature_flags (name, enabled, updated_at, updated_by)
VALUES ('saved_search_alerts_enabled', 0, 0, 'system')
ON CONFLICT (name) DO NOTHING;

-- graphql_enabled ships OFF (#1126): the /graphql endpoint 404s until an
-- operator turns it on via the admin feature-flag API.
INSERT INTO feature_flags (name, enabled, updated_at, updated_by)
VALUES ('graphql_enabled',             0, 0, 'system')
ON CONFLICT (name) DO NOTHING;
