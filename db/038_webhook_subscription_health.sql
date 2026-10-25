-- Migration 038: per-subscription health tracking for webhook circuit breaking
-- and automatic suspension (#1512). Timestamps are epoch milliseconds.

ALTER TABLE webhook_subscriptions ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhook_subscriptions ADD COLUMN failing_since INTEGER;
ALTER TABLE webhook_subscriptions ADD COLUMN last_failure_at INTEGER;
ALTER TABLE webhook_subscriptions ADD COLUMN last_success_at INTEGER;
ALTER TABLE webhook_subscriptions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'degraded', 'suspended'));
ALTER TABLE webhook_subscriptions ADD COLUMN suspended_at INTEGER;
ALTER TABLE webhook_subscriptions ADD COLUMN suspended_reason TEXT;
