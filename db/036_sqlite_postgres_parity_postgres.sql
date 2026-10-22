-- Portable historical migrations used INTEGER for epoch milliseconds. Widen
-- them before importing production SQLite values; preserve the epoch units.
ALTER TABLE api_keys ALTER COLUMN revoke_after TYPE BIGINT;
ALTER TABLE api_key_usage ALTER COLUMN created_at TYPE BIGINT;
ALTER TABLE api_key_usage ALTER COLUMN updated_at TYPE BIGINT;
ALTER TABLE security_event_log ALTER COLUMN created_at TYPE BIGINT;
ALTER TABLE data_export_jobs ALTER COLUMN created_at TYPE BIGINT;
ALTER TABLE data_export_jobs ALTER COLUMN started_at TYPE BIGINT;
ALTER TABLE data_export_jobs ALTER COLUMN completed_at TYPE BIGINT;
ALTER TABLE data_export_jobs ALTER COLUMN expires_at TYPE BIGINT;
ALTER TABLE export_download_tokens ALTER COLUMN used_at TYPE BIGINT;
ALTER TABLE export_download_tokens ALTER COLUMN expires_at TYPE BIGINT;
ALTER TABLE export_download_tokens ALTER COLUMN created_at TYPE BIGINT;
ALTER TABLE trial_offers ALTER COLUMN expires_at TYPE BIGINT;
ALTER TABLE trial_offers ALTER COLUMN cancelled_at TYPE BIGINT;
-- The application inserts subscription URLs/secrets with no timestamps. Match
-- SQLite's text created_at default and optional update metadata, preserving data.
ALTER TABLE webhook_subscriptions ALTER COLUMN created_at TYPE TEXT USING created_at::text;
ALTER TABLE webhook_subscriptions ALTER COLUMN created_at SET DEFAULT (NOW() AT TIME ZONE 'utc')::text;
ALTER TABLE webhook_subscriptions ALTER COLUMN updated_at DROP NOT NULL;
ALTER TABLE webhook_subscriptions DROP CONSTRAINT IF EXISTS webhook_subscriptions_url_key;
-- SQLite permits post-migration inserts with an omitted/null registered_at.
-- Preserve those values instead of requiring a lossy migration-time backfill.
ALTER TABLE players ALTER COLUMN registered_at DROP NOT NULL;
