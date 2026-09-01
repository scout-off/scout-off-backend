-- Migration 012: tamper-evident hash chain for audit_log (#464)
--
-- audit_log (see 002_audit_log.sql) already persists both admin actions
-- (src/services/audit.ts's logAuditEvent) to SQLite. This adds a hash chain
-- so any retroactive edit or deletion of a historical row is detectable:
-- each row's `hash` is derived from its own content plus the previous row's
-- `hash` (`prev_hash`), forming an unbroken chain from the first row onward.
-- See src/utils/hashChain.ts and src/utils/auditVerify.ts.
--
-- `event_source` distinguishes rows written by admin actions from
-- application-level events (src/utils/audit.ts's recordAudit/queryAudit,
-- formerly backed by an in-memory array that this migration's app-side
-- changes replace) now that both flow through this single table/chain.
--
-- SQLite requires one ADD COLUMN per statement.
ALTER TABLE audit_log ADD COLUMN prev_hash TEXT;
ALTER TABLE audit_log ADD COLUMN hash TEXT NOT NULL DEFAULT '';
ALTER TABLE audit_log ADD COLUMN event_source TEXT NOT NULL DEFAULT 'admin_action';
