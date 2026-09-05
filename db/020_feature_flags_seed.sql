-- Migration 020: seed additional runtime feature flags (#805)
-- Adds player_tokens_enabled, saved_search_alerts_enabled, and graphql_enabled
-- flags so operators can toggle them without a DB migration or service restart.
-- INSERT OR IGNORE so existing rows (e.g. saved_searches from 010) are unchanged.

INSERT OR IGNORE INTO feature_flags (name, enabled, updated_at, updated_by)
VALUES ('player_tokens_enabled',       0, 0, 'system');

INSERT OR IGNORE INTO feature_flags (name, enabled, updated_at, updated_by)
VALUES ('saved_search_alerts_enabled', 0, 0, 'system');

-- graphql_enabled ships OFF (#1126): the /graphql endpoint 404s until an
-- operator turns it on via the admin feature-flag API.
INSERT OR IGNORE INTO feature_flags (name, enabled, updated_at, updated_by)
VALUES ('graphql_enabled',             0, 0, 'system');
