-- Migration 019: add scout_wallet and event_types to webhook_subscriptions (#806, PostgreSQL)

ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS scout_wallet TEXT;
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS event_types  TEXT;

CREATE INDEX IF NOT EXISTS idx_webhook_sub_scout ON webhook_subscriptions (scout_wallet);
