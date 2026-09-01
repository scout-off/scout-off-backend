import { logger } from '../utils/logger';
import { logWithoutRedaction } from '../utils/logRedaction';
import { insertAuditLog } from '../db';

export interface AuditEvent {
  action: string;
  timestamp: string;
  /** Optional: contract action name for admin smart contract interactions (e.g. 'pause_contract') */
  contractAction?: string;
  adminWallet?: string;
  queryParams?: Record<string, unknown>;
  /** Optional: request path, for auth_failed/auth_forbidden events. */
  path?: string;
  /** Optional: human-readable reason, for auth_failed/auth_forbidden events. */
  reason?: string;
  /** Optional: role required by the route, for auth_failed/auth_forbidden events. */
  requiredRole?: string;
  /** Optional: API-key scope required by the route, for auth_failed/auth_forbidden events (#1019). */
  requiredScope?: string;
}

/**
 * Log an audit event for compliance tracking.
 * Persists to the tamper-evident audit_log table and emits an info log line.
 *
 * A persistence failure is never swallowed silently: it is logged at
 * `critical` severity with the full event and error detail, then rethrown so
 * a caller that awaits this can surface it (e.g. fail the admin action
 * rather than let it proceed with no audit trail). Callers that intentionally
 * treat auditing as best-effort (e.g. auth failure logging, where blocking a
 * 401 response on a DB round-trip is undesirable) must attach their own
 * `.catch()` — see src/middleware/auth.ts — rather than this function
 * swallowing the error on their behalf.
 *
 * Audit logs bypass redaction to preserve full wallet addresses for compliance.
 */
export async function logAuditEvent(event: AuditEvent): Promise<void> {
  // Use audit-safe logging that bypasses redaction
  logWithoutRedaction('info', '[audit]', JSON.stringify(event));
  try {
    await insertAuditLog({
      action: event.contractAction ?? event.action,
      adminWallet: event.adminWallet,
      queryParams: { ...event.queryParams, ...(event.contractAction ? { parentAction: event.action } : {}) },
      createdAt: event.timestamp,
    });
  } catch (err) {
    // Also bypass redaction for critical errors
    logWithoutRedaction('critical', '[audit] failed to persist audit event to DB — audit trail has a gap', {
      event,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
