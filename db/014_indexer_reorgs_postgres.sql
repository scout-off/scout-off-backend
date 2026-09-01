ALTER TABLE events ADD COLUMN ledger_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_events_ledger ON events (ledger);
