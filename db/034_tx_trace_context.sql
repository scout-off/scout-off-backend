-- Durable W3C context bridge; separate from optional request correlation ids.
CREATE TABLE IF NOT EXISTS tx_trace_context (
  tx_hash TEXT PRIMARY KEY,
  traceparent TEXT NOT NULL,
  tracestate TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_trace_context_created_at ON tx_trace_context(created_at);
