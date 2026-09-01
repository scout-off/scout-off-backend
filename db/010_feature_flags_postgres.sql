-- Migration 010: runtime feature flags (#494)
-- Boolean flags toggled via admin API without redeploying.
--
-- Mirrors db/010_feature_flags.sql's columns exactly (name PK, enabled,
-- updated_at, updated_by), including `enabled` being INTEGER (0/1) rather
-- than a native BOOLEAN. The previous version of this file had drifted in
-- three ways: a surrogate `id` PK instead of `name`, no `updated_by` column
-- at all, and a required `created_at` with no default — so
-- upsertFeatureFlag() (src/db/index.ts), which inserts
-- (name, enabled, updated_at, updated_by), threw under DB_DRIVER=postgres on
-- every write (missing column / NOT NULL violation). `enabled` stays
-- INTEGER rather than becoming BOOLEAN because upsertFeatureFlag's `enabled`
-- parameter is a plain 0/1 number shared verbatim across both drivers' `?`
-- placeholders — `pg` sends a JS number as an integer-typed parameter, and
-- Postgres has no implicit integer-to-boolean assignment cast, so binding a
-- 0/1 number against a BOOLEAN column fails outright ("column enabled is of
-- type boolean but expression is of type integer").

CREATE TABLE IF NOT EXISTS feature_flags (
  name       TEXT    PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  updated_at BIGINT  NOT NULL,
  updated_by TEXT    NOT NULL
);

-- Seed the saved-searches flag enabled so existing behaviour is unchanged.
INSERT INTO feature_flags (name, enabled, updated_at, updated_by)
VALUES ('saved_searches', 1, 0, 'system')
ON CONFLICT (name) DO NOTHING;
