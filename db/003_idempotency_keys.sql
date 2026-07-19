CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  request_hash TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 0,
  response_body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
