-- Migration 027 (PostgreSQL): add expiry and cancellation support to trial_offers (#expiry)
--
-- See 027_trial_offer_expiry.sql for full description.

ALTER TABLE trial_offers ADD COLUMN IF NOT EXISTS expires_at   INTEGER;
ALTER TABLE trial_offers ADD COLUMN IF NOT EXISTS cancelled_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_trial_offers_expires ON trial_offers (expires_at);
