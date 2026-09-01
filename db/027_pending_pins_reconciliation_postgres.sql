-- Migration 027: pending_pins reconciliation support (PostgreSQL)
--
-- Adds status, expired_reason, and last_reconciled_at to pending_pins to support
-- scheduled reconciliation against Pinata and IPFS gateways.

ALTER TABLE pending_pins ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE pending_pins ADD COLUMN IF NOT EXISTS expired_reason TEXT;
ALTER TABLE pending_pins ADD COLUMN IF NOT EXISTS last_reconciled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_pending_pins_status_created ON pending_pins (status, created_at);
