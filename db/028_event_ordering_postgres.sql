-- Migration 028 (Postgres): deterministic event ordering + tx correlation (#1111, #1113)

ALTER TABLE events ADD COLUMN IF NOT EXISTS tx_application_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN IF NOT EXISTS contract_id TEXT NOT NULL DEFAULT '';

-- Drop the legacy single-column UNIQUE(tx_hash) so co-transaction events survive.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_tx_hash_key;
DROP INDEX IF EXISTS events_tx_hash_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_tx_event
  ON events (tx_hash, event_index);
CREATE INDEX IF NOT EXISTS idx_events_ordinal
  ON events (ledger, tx_application_order, event_index, contract_id);

CREATE TABLE IF NOT EXISTS tx_correlations (
  tx_hash        TEXT PRIMARY KEY,
  correlation_id TEXT NOT NULL,
  created_at     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tx_correlations_created_at
  ON tx_correlations (created_at);
