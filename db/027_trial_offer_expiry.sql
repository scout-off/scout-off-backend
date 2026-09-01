-- Migration 027: add expiry and cancellation support to trial_offers (#expiry)
--
-- expires_at   — Unix epoch seconds after which accept/reject attempts are
--               rejected. Set to NOW + TRIAL_OFFER_TTL_MS on insert.
--               NULL on rows created before this migration (treated as
--               non-expiring for backward compat).
-- cancelled_at — Unix epoch seconds when the originating scout withdrew the
--               offer. NULL unless the scout has cancelled it.

ALTER TABLE trial_offers ADD COLUMN expires_at   INTEGER;
ALTER TABLE trial_offers ADD COLUMN cancelled_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_trial_offers_expires ON trial_offers (expires_at);
