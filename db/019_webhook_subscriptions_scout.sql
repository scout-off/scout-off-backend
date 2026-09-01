-- Migration 019: add scout_wallet and event_types to webhook_subscriptions (#806)
-- Allows scouts to self-register webhook subscriptions scoped to their wallet.
-- event_types is a JSON array of ContractEventType strings (NULL = all events).

ALTER TABLE webhook_subscriptions ADD COLUMN scout_wallet TEXT;
ALTER TABLE webhook_subscriptions ADD COLUMN event_types  TEXT;

CREATE INDEX IF NOT EXISTS idx_webhook_sub_scout ON webhook_subscriptions (scout_wallet);
