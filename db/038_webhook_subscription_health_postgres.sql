-- Migration 038: per-subscription health tracking for webhook circuit breaking
-- and automatic suspension (#1512, PostgreSQL). Timestamps are epoch milliseconds.

ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS failing_since BIGINT;
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS last_failure_at BIGINT;
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS last_success_at BIGINT;
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'degraded', 'suspended'));
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS suspended_at BIGINT;
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS suspended_reason TEXT;
