import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getAuditLogs, getAuditLogsCount, type AuditLogRow } from '../db';
import { verifyAuditChainFull } from '../utils/auditVerify';
import { ErrorCode } from '../utils/errorCodes';

export const KNOWN_AUDIT_EVENT_TYPES = [
  // Admin action events (event_source = 'admin_action')
  'fee_history_query',
  'contract_state_change',
  'validator_registration',
  'validator_revocation',
  'fee_withdrawal_attempt',
  'platform_fee_update_attempt',
  'bulk_validator_import',
  // App-level events (event_source = 'app_event')
  'player_registered',
  'profile_updated',
  'milestone_submitted',
  'milestone_approved',
  'player_search',
  'pending_milestones_viewed',
  // Auth events
  'auth_failed',
  'auth_forbidden',
] as const;

export type AuditEventType = (typeof KNOWN_AUDIT_EVENT_TYPES)[number];

/**
 * Canonical response shape for a single audit log entry (#832).
 * Maps the internal `audit_log` column names to the public API contract.
 */
export interface AuditEntryResponse {
  id: number;
  event_type: string;
  actor_wallet: string;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  hash: string;
}

/**
 * Convert a raw audit row to the public response shape.
 */
function rowToAuditEntry(row: AuditLogRow): AuditEntryResponse {
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(row.query_params) as Record<string, unknown>;
  } catch {
    // Leave params empty — malformed JSON should not crash the endpoint.
  }
  const { target_id, targetId, validatorWallet, player_id, playerId, ...rest } = params;
  // Prefer explicit target_id / targetId keys; fall back to common domain keys.
  const resolvedTargetId =
    (target_id as string | undefined) ??
    (targetId as string | undefined) ??
    (validatorWallet as string | undefined) ??
    (player_id as string | undefined) ??
    (playerId as string | undefined) ??
    null;
  return {
    id: row.id,
    event_type: row.action,
    actor_wallet: row.admin_wallet,
    target_id: resolvedTargetId,
    metadata: { ...rest },
    created_at: row.created_at,
    hash: row.hash,
  };
}

const auditQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** GET /api/admin/audit (legacy #345 endpoint — backward-compatible) */
export async function getAuditLog(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = auditQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
      code: ErrorCode.VALIDATION_ERROR,
    });
    return;
  }
  const { startDate, endDate, action, limit, offset } = parsed.data;
  const rows = await getAuditLogs({ action, startDate, endDate, limit, offset });
  const total = await getAuditLogsCount({ action, startDate, endDate });
  res.json({
    success: true,
    data: rows.map((r) => ({ ...r, query_params: JSON.parse(r.query_params) })),
    total,
    limit,
    offset,
  });
}

// ─── Audit trail endpoint (#832) ──────────────────────────────────────────────

const auditTrailQuerySchema = z.object({
  /** Filter by audit event type. Must be one of the known event types. */
  eventType: z
    .string()
    .refine(
      (v) => (KNOWN_AUDIT_EVENT_TYPES as readonly string[]).includes(v),
      (v) => ({ message: `Invalid eventType "${v}". Must be one of: ${KNOWN_AUDIT_EVENT_TYPES.join(', ')}` })
    )
    .optional(),
  /** ISO 8601 start of date range (inclusive). */
  from: z
    .string()
    .refine((v) => !isNaN(Date.parse(v)), { message: 'from must be a valid ISO 8601 date string' })
    .optional(),
  /** ISO 8601 end of date range (inclusive). */
  to: z
    .string()
    .refine((v) => !isNaN(Date.parse(v)), { message: 'to must be a valid ISO 8601 date string' })
    .optional(),
  /** 1-based page number (default: 1). */
  page: z.coerce.number().int().min(1).default(1),
  /** Number of entries per page, max 100 (default: 50). */
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
}).refine(
  (d) => {
    if (d.from && d.to) {
      return new Date(d.from) <= new Date(d.to);
    }
    return true;
  },
  { message: 'from must not be after to' }
);

/**
 * GET /api/admin/audit/trail
 *
 * Returns paginated, filterable audit trail entries in a structured AuditEntry
 * shape. Accepts ?eventType=, ?from=, ?to= (ISO 8601), ?page=, ?pageSize=.
 *
 * @response 200 { success: true, data: AuditEntry[], total, page, pageSize }
 * @response 400 { success: false, error: string } - Invalid query parameters
 * @auth Bearer (admin role required)
 */
export async function getAuditTrail(req: Request, res: Response, next: NextFunction): Promise<void> {
  const parsed = auditTrailQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
      code: ErrorCode.VALIDATION_ERROR,
    });
    return;
  }

  const { eventType, from, to, page, pageSize } = parsed.data;
  const offset = (page - 1) * pageSize;

  const rows = await getAuditLogs({
    action: eventType,
    startDate: from,
    endDate: to,
    limit: pageSize,
    offset,
  });

  const total = await getAuditLogsCount({
    action: eventType,
    startDate: from,
    endDate: to,
  });

  res.json({
    success: true,
    data: rows.map(rowToAuditEntry),
    total,
    page,
    pageSize,
  });
}

/**
 * GET /api/admin/audit/verify
 *
 * Walks the full audit_log hash chain, collecting every violation rather than
 * stopping at the first broken row (#764). Returns a structured integrity
 * report with status 'ok' | 'tampered' | 'timeout', a violations array, the
 * total chain_length, and rows_checked. Useful for periodic compliance checks
 * and incident response.
 */
export async function getAuditChainVerification(req: Request, res: Response, next: NextFunction): Promise<void> {
  const result = await verifyAuditChainFull();
  res.json({ success: true, data: result });
}
