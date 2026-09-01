-- Migration 007: add resolved_cid to pending_pins for cross-instance dedup (#656) (PostgreSQL)
--
-- The pending_pins row doubles as a distributed mutex (via INSERT … ON CONFLICT DO NOTHING
-- on the unique hash index). After the winning instance finishes its Pinata upload it writes
-- the resulting CID into this column so any waiting instance can read the CID from the DB
-- instead of launching a duplicate upload.
ALTER TABLE pending_pins ADD COLUMN IF NOT EXISTS resolved_cid TEXT;
