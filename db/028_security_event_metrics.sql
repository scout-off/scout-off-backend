-- Migration 028: Security event pub/sub metrics (#1326)
--
-- Cross-instance wallet blocklist and token revocation propagation (#1326)
-- requires Redis pub/sub channels (security:wallet_blocked, security:wallet_unblocked,
-- security:token_revoked) to coordinate cache invalidation and session termination.
--
-- This migration adds metrics tracking for these propagated events so operators
-- can monitor the effectiveness of cross-instance security enforcement.
--
-- New table security_event_log tracks published security events for audit and metrics:
--   - event_type: 'wallet_blocked', 'wallet_unblocked', 'token_revoked'
--   - subject: wallet address or token hash
--   - origin_instance_id: instance that initiated the event
--   - propagated_count: number of other instances that received and processed it

CREATE TABLE IF NOT EXISTS security_event_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type        TEXT    NOT NULL,
  subject           TEXT    NOT NULL,
  origin_instance_id TEXT    NOT NULL,
  propagated_count  INTEGER DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_event_log_type ON security_event_log (event_type);
CREATE INDEX IF NOT EXISTS idx_security_event_log_subject ON security_event_log (subject);
CREATE INDEX IF NOT EXISTS idx_security_event_log_created_at ON security_event_log (created_at);
