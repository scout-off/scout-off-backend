-- Migration 033: webhook signature versioning (#687)
--
-- Adds previous_secret and previous_secret_expires_at columns to support
-- zero-downtime secret rotation with dual-signing during the transition window.

ALTER TABLE webhook_subscriptions ADD COLUMN previous_secret TEXT;
ALTER TABLE webhook_subscriptions ADD COLUMN previous_secret_expires_at TEXT;