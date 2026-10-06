-- Migration 023: Exactly-once delivery — client ACK tracking table (PostgreSQL)

CREATE TABLE IF NOT EXISTS client_delivery_acks (
  client_id   TEXT    NOT NULL,
  room_id     TEXT    NOT NULL,
  highest_seq INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
  PRIMARY KEY (client_id, room_id)
);

CREATE INDEX IF NOT EXISTS idx_client_delivery_acks_updated
  ON client_delivery_acks (updated_at);
