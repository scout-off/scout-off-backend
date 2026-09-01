-- Migration 006: hash column and unique index for pending_pins dedup mutex (#466)

ALTER TABLE pending_pins ADD COLUMN hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_pins_hash ON pending_pins (hash);
