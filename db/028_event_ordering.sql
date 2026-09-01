-- Migration 028: deterministic cross-contract event ordering (#1111)
--
-- Every indexed event carries an explicit ordinal:
--   (ledger, tx_application_order, event_index)
-- plus contract_id so multi-contract fan-out can break ties stably.
--
-- UNIQUE(tx_hash) is replaced with UNIQUE(tx_hash, event_index) so
-- co-transaction events (multiple contract events in one tx) are retained
-- rather than collapsed by INSERT OR IGNORE.

CREATE TABLE events_ordered (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  type                 TEXT    NOT NULL,
  ledger               INTEGER NOT NULL,
  ledger_hash          TEXT,
  tx_hash              TEXT    NOT NULL,
  payload              TEXT    NOT NULL,
  created_at           INTEGER,
  tx_application_order INTEGER NOT NULL DEFAULT 0,
  event_index          INTEGER NOT NULL DEFAULT 0,
  contract_id          TEXT    NOT NULL DEFAULT ''
);

INSERT INTO events_ordered (
  id, type, ledger, ledger_hash, tx_hash, payload, created_at,
  tx_application_order, event_index, contract_id
)
SELECT
  id, type, ledger, ledger_hash, tx_hash, payload, created_at,
  0, 0, ''
FROM events;

DROP TABLE events;
ALTER TABLE events_ordered RENAME TO events;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_tx_event
  ON events (tx_hash, event_index);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (type);
CREATE INDEX IF NOT EXISTS idx_events_ledger ON events (ledger);
CREATE INDEX IF NOT EXISTS idx_events_ordinal
  ON events (ledger, tx_application_order, event_index, contract_id);

-- Off-chain bridge for request → tx → indexer → webhook correlation (#1113).
-- Correlation IDs are never put on-chain as PII; the memo carries a short
-- nonce and this table maps the resulting tx_hash back to the full id.
CREATE TABLE IF NOT EXISTS tx_correlations (
  tx_hash        TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_correlations_created_at
  ON tx_correlations (created_at);
