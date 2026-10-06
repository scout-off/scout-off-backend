-- Migration 023: Exactly-once delivery — client ACK tracking table
-- Supports Option A: server-side ACK persistence for ACK recovery on server restart.
-- Option B (client-reported highestAckedSeq) does not require this table but it
-- provides a fallback and audit trail.

CREATE TABLE IF NOT EXISTS client_delivery_acks (
  client_id   TEXT    NOT NULL,
  room_id     TEXT    NOT NULL,
  highest_seq INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (client_id, room_id)
);

-- Index for cleanup queries (delete stale ACKs for disconnected clients)
CREATE INDEX IF NOT EXISTS idx_client_delivery_acks_updated
  ON client_delivery_acks (updated_at);
