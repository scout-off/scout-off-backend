-- Migration 033: indexer_unprocessed_events (SQLite).
--
-- Stores contract events the indexer could not apply — an unrecognised topic
-- (`unknown_type`) or one whose value failed to decode (`decode_error`) — so
-- they are not silently dropped. Rows keep the raw topic/value XDR needed to
-- replay the event via POST /api/admin/indexer/unprocessed/:id/retry once the
-- decoder is fixed. Deduplicated on (tx_hash, event_index) so re-polling the
-- same event never creates a second row. See docs/indexer.md (#1540).

CREATE TABLE IF NOT EXISTS indexer_unprocessed_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT,
  ledger      INTEGER,
  tx_hash     TEXT NOT NULL,
  event_index INTEGER NOT NULL DEFAULT 0,
  contract_id TEXT,
  -- JSON array of the event's raw topics (base64 XDR), retained for replay.
  topic_json  TEXT,
  -- Base64 XDR of the event's raw value, retained for replay.
  value_xdr   TEXT,
  -- Machine-readable reason: 'unknown_type' or 'decode_error'.
  reason      TEXT NOT NULL,
  -- JSON-encoded partially-decoded payload, when available.
  payload     TEXT,
  created_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_indexer_unprocessed_tx_event
  ON indexer_unprocessed_events (tx_hash, event_index);
