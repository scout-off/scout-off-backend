import { createHash } from 'crypto';
import { insertAuditLog, getAllAuditLogRows, AuditLogRow } from '../db';

export type AuditEventType =
  | 'player_registered'
  | 'profile_updated'
  | 'milestone_submitted'
  | 'milestone_approved'
  | 'player_search'
  | 'pending_milestones_viewed';

export interface AuditEntry {
  actorWallet: string;
  eventType: AuditEventType;
  payloadHash: string;
  timestamp: number;
  /** Optional free-text notes for searchability and context. */
  notes?: string;
}

/** event_source tag used for rows written by recordAudit (as opposed to
 * admin actions, written via src/services/audit.ts's logAuditEvent). */
const APP_EVENT_SOURCE = 'app_event';

function rowToEntry(row: AuditLogRow): AuditEntry {
  let extra: { payloadHash?: string; notes?: string } = {};
  try {
    extra = JSON.parse(row.query_params) as { payloadHash?: string; notes?: string };
  } catch {
    // Should not happen — query_params is always written as JSON by recordAudit.
  }
  return {
    actorWallet: row.admin_wallet,
    eventType: row.action as AuditEventType,
    payloadHash: extra.payloadHash ?? '',
    timestamp: Date.parse(row.created_at),
    ...(extra.notes !== undefined ? { notes: extra.notes } : {}),
  };
}

/**
 * Records an audit entry for a player registration, profile update, or milestone event.
 *
 * Persisted to the tamper-evident `audit_log` table (see #464) rather than an
 * in-memory array — entries now survive process restarts and are queryable
 * across instances. Async because insertAuditLog runs inside a driver
 * transaction (required so the hash-chain read-then-insert is atomic on
 * PostgreSQL too — see src/db/index.ts's insertAuditLog).
 *
 * @param actorWallet - Stellar wallet address of the actor
 * @param eventType   - Type of event being audited
 * @param payload     - Raw payload to hash (SHA-256) — only the hash is persisted, not the raw payload
 * @param notes       - Optional free-text notes for searchability
 */
export async function recordAudit(
  actorWallet: string,
  eventType: AuditEventType,
  payload: Record<string, unknown>,
  notes?: string
): Promise<AuditEntry> {
  // Strip log injection characters from optional notes
  const sanitizedNotes = notes?.replace(/[\r\n]+/g, ' ');
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const row = await insertAuditLog({
    action: eventType,
    adminWallet: actorWallet,
    queryParams: { payloadHash, ...(sanitizedNotes !== undefined ? { notes: sanitizedNotes } : {}) },
    createdAt: new Date().toISOString(),
    eventSource: APP_EVENT_SOURCE,
  });
  return rowToEntry(row);
}

/**
 * Returns all app-level audit entries (oldest first), optionally filtered by
 * eventType and/or actorWallet. Reads from the persistent, hash-chained
 * audit_log table — restricted to event_source='app_event' rows so this
 * doesn't surface unrelated admin actions logged via logAuditEvent.
 */
export async function queryAudit(filter?: { eventType?: AuditEventType; actorWallet?: string }): Promise<AuditEntry[]> {
  const rows = await getAllAuditLogRows({
    eventSource: APP_EVENT_SOURCE,
    action: filter?.eventType,
    actorWallet: filter?.actorWallet,
  });
  return rows.map(rowToEntry);
}
