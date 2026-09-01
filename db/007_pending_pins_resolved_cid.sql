-- Migration 007: add resolved_cid to pending_pins for cross-instance dedup (#656)
--
-- The pending_pins row doubles as a distributed mutex (via INSERT OR IGNORE on the
-- unique hash index). After the winning instance finishes its Pinata upload it now
-- writes the resulting CID into this column so any other instance that was waiting
-- on the lock can read the CID directly from the DB instead of launching a second
-- upload.
ALTER TABLE pending_pins ADD COLUMN resolved_cid TEXT;
