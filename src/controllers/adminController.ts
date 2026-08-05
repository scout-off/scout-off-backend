import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { queryEvents, countEventsFiltered, getEventsPage, fetchLastIndexedLedger, persistLastIndexedLedger, getValidatorStats, getAuditLogs, getAuditLogsCount, AuditLogRow, getNewPlayersTimeSeries, getMilestonesApprovedTimeSeries, getContactUnlocksTimeSeries, getSubscriptionsStartedTimeSeries, getNewPlayersByRegionTimeSeries, TimeSeriesPoint, RegionBreakdownPoint } from '../db';
import { getAllValidators, insertValidator, revokeValidatorRow, getValidatorByWallet } from '../services/indexer';
import { isValidStellarAddress } from '../utils/stellarAddress';
import { STELLAR_ADDRESS_RE } from '../utils/validators';
import { logAuditEvent } from '../services/audit';
import { verifyAuditChain } from '../utils/auditVerify';
import { withdrawFees as stellarWithdrawFees, FeeWithdrawalError, FeeWithdrawalResult, getFeeBalance, pauseContractOnChain, unpauseContractOnChain, registerValidatorOnChain, revokeValidatorOnChain, ValidatorActionError } from '../services/stellar';
import { revokeToken, isTokenRevoked } from '../services/tokenBlocklist';
import { cacheGet, cacheSet } from '../services/cache';
import config from '../config';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';
import { proposeAction, approveAction, listPendingActions, getActionDetails } from '../services/adminMultiSig';
import { withConcurrencyLimit } from '../utils/concurrency';
import type { ApiResponse, EventRecord, ContractEventType } from '../types';

// ─── Audit trail types & constants (#832) ─────────────────────────────────────

/**
 * The exhaustive set of audit event types that the platform can emit.
 * Used for validation of the ?eventType query parameter.
 */
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
 * Send a consistent 400 response for a failed Zod parse: a generic top-level
 * `error: 'Validation Error'` label plus a `details` array of per-field
 * messages (mirrors the shape already produced by validateBody/validateQuery
 * in src/middleware/validate.ts for routes that use that middleware).
 */
function sendValidationError(res: Response, error: z.ZodError): void {
  const details = error.errors.map((e) => ({ field: e.path.join('.'), message: e.message }));
  res.status(400).json({ success: false, error: 'Validation Error', details, code: ErrorCode.VALIDATION_ERROR });
}

/**
 * Convert a raw DB row to the public AuditEntry response shape.
 * `target_id` is extracted from query_params if present there.
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

// Use shared validator for Stellar public keys

const statsQuerySchema = z.object({
  window: z.enum(['7d', '30d', '90d']).optional(),
  breakdown: z.enum(['region']).optional(),
});

/** GET /api/admin/stats */
export async function getStats(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = statsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    const { window, breakdown } = parsed.data;

    // If no window or breakdown requested, return basic stats (backward compatible)
    if (!window && !breakdown) {
      res.json({
        success: true,
        data: {
          players: queryEvents('player_registered').length,
          milestones: queryEvents('milestone_approved').length,
          subscriptions: queryEvents('scout_subscribed').length,
          events: queryEvents().length,
        },
      });
      return;
    }

    // Default to 30d if window is not specified but breakdown is
    const windowValue = window ?? '30d';

    // Calculate time window
    const windowDays = windowValue === '7d' ? 7 : windowValue === '30d' ? 30 : 90;
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - windowDays);

    const startDateMs = startDate.getTime();
    const endDateMs = endDate.getTime();

    // Generate cache key
    const cacheKey = `admin:stats:${windowValue}:${breakdown ?? 'none'}`;
    const cached = await cacheGet<{ data: Record<string, unknown> }>(cacheKey);
    if (cached) {
      res.json({ success: true, data: cached.data });
      return;
    }

    // Fetch time-series data
    const newPlayers = getNewPlayersTimeSeries(startDateMs, endDateMs);
    const milestonesApproved = getMilestonesApprovedTimeSeries(startDateMs, endDateMs);
    const contactUnlocks = getContactUnlocksTimeSeries(startDateMs, endDateMs);
    const subscriptionsStarted = getSubscriptionsStartedTimeSeries(startDateMs, endDateMs);

    const data: Record<string, unknown> = {
      window: windowValue,
      startDate: startDate.toISOString().split('T')[0],
      endDate: endDate.toISOString().split('T')[0],
      newPlayers,
      milestonesApproved,
      contactUnlocks,
      subscriptionsStarted,
    };

    // Add region breakdown if requested
    if (breakdown === 'region') {
      const newPlayersByRegion = getNewPlayersByRegionTimeSeries(startDateMs, endDateMs);
      data.newPlayersByRegion = newPlayersByRegion;
    }

    // Cache for 5 minutes (300000ms)
    await cacheSet(cacheKey, { data }, 5 * 60 * 1000);

    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

const isoDateString = z
  .string()
  .refine((v) => !isNaN(Date.parse(v)), { message: 'Must be a valid ISO 8601 date string' })
  .transform((v) => new Date(v));

const auditQuerySchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

/** GET /api/admin/audit (legacy #345 endpoint — backward-compatible) */
export async function getAuditLog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
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
    const rows = getAuditLogs({ action, startDate, endDate, limit, offset });
    const total = getAuditLogsCount({ action, startDate, endDate });
    res.json({
      success: true,
      data: rows.map((r) => ({ ...r, query_params: JSON.parse(r.query_params) })),
      total,
      limit,
      offset,
    });
  } catch (err) {
    next(err);
  }
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
  try {
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

    const rows = getAuditLogs({
      action: eventType,
      startDate: from,
      endDate: to,
      limit: pageSize,
      offset,
    });

    const total = getAuditLogsCount({
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
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/audit/verify
 *
 * Walks the audit_log hash chain end-to-end and reports whether it is intact,
 * or — if not — the id of the first row where it breaks (see #464). Useful
 * for periodic compliance checks / incident response: a `valid: false`
 * result means a historical row was edited, deleted, or reordered outside
 * the application (e.g. direct DB access).
 */
export async function getAuditChainVerification(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = verifyAuditChain();
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

/** Exported so routes can apply validateQuery(adminDateRangeSchema) */
export const adminDateRangeSchema = z.object({
  startDate: isoDateString.optional(),
  endDate: isoDateString.optional(),
  eventType: z.string().optional(),
}).refine(
  (d) => !(d.startDate && d.endDate && d.startDate > d.endDate),
  { message: 'startDate must not be after endDate' }
);

/**
 * Zod schema for all query parameters accepted by GET /api/admin/events.
 *
 * Supports two pagination styles for backwards compatibility:
 *   - Legacy:  ?limit=N&offset=M   (max limit 100, offset >= 0)
 *   - Modern:  ?page=N&pageSize=N  (max pageSize 200, page >= 1)
 *
 * Date-range filtering via ?startDate / ?endDate (ISO 8601) or the shorter
 * aliases ?from / ?to are both accepted and normalised to startDate/endDate.
 */
const eventsQuerySchema = z
  .object({
    // ── date-range ─────────────────────────────────────────────────────────
    startDate: z
      .string()
      .refine((v) => !isNaN(Date.parse(v)), { message: 'startDate must be a valid ISO 8601 date' })
      .optional(),
    endDate: z
      .string()
      .refine((v) => !isNaN(Date.parse(v)), { message: 'endDate must be a valid ISO 8601 date' })
      .optional(),
    from: z
      .string()
      .refine((v) => !isNaN(Date.parse(v)), { message: 'from must be a valid ISO 8601 date' })
      .optional(),
    to: z
      .string()
      .refine((v) => !isNaN(Date.parse(v)), { message: 'to must be a valid ISO 8601 date' })
      .optional(),
    // ── event type ─────────────────────────────────────────────────────────
    eventType: z.string().optional(),
    // ── legacy pagination (limit / offset) ─────────────────────────────────
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    // ── modern pagination (page / pageSize) ────────────────────────────────
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(200).optional(),
    // ── ledger range ────────────────────────────────────────────────────────
    fromLedger: z.coerce.number().int().min(0).optional(),
    toLedger: z.coerce.number().int().min(0).optional(),
  })
  .refine(
    (d) => {
      const start = d.startDate ?? d.from;
      const end = d.endDate ?? d.to;
      if (start && end) return new Date(start) <= new Date(end);
      return true;
    },
    { message: 'startDate must not be after endDate' },
  )
  .refine(
    (d) => {
      if (d.fromLedger !== undefined && d.toLedger !== undefined) {
        return d.fromLedger <= d.toLedger;
      }
      return true;
    },
    { message: 'fromLedger must not be greater than toLedger' },
  );

/** GET /api/admin/events */
export async function getAllEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = eventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }

    const { startDate, endDate, from, to, eventType, limit, offset, page, pageSize } = parsed.data;

    // Resolve date range — ?from/?to are aliases for ?startDate/?endDate
    const resolvedStart = startDate ?? from;
    const resolvedEnd = endDate ?? to;
    const startDateObj = resolvedStart ? new Date(resolvedStart) : undefined;
    const endDateObj = resolvedEnd ? new Date(resolvedEnd) : undefined;

    const eventTypeFilter = eventType as ContractEventType | undefined;

    // Resolve pagination — legacy limit/offset takes precedence when supplied;
    // falls back to page/pageSize, then defaults (limit=20, offset=0).
    const resolvedLimit = limit ?? pageSize ?? 20;
    const resolvedOffset = offset ?? ((page ?? 1) - 1) * resolvedLimit;

    const filter = { type: eventTypeFilter, startDate: startDateObj, endDate: endDateObj };

    // Fetch the page from the DB (date filtering happens at SQL level)
    const rows = getEventsPage(filter, resolvedLimit, resolvedOffset);
    const total = countEventsFiltered(filter);
    const totalPages = Math.ceil(total / resolvedLimit);

    const data = rows.map((r) => ({
      source: '',
      type: r.type,
      payload: r.payload,
      contractAddress: '',
      created_at: r.createdAt,
    }));

    res.json({
      success: true,
      data,
      total,
      // Return both pagination styles so existing callers keep working
      limit: resolvedLimit,
      offset: resolvedOffset,
      page: Math.floor(resolvedOffset / resolvedLimit) + 1,
      pageSize: resolvedLimit,
      totalPages,
    });
  } catch (err) {
    next(err);
  }
}

const feesQuerySchema = z
  .object({
    startDate: z
      .string()
      .refine((v) => !isNaN(Date.parse(v)), { message: 'startDate must be a valid ISO 8601 date' })
      .optional(),
    endDate: z
      .string()
      .refine((v) => !isNaN(Date.parse(v)), { message: 'endDate must be a valid ISO 8601 date' })
      .optional(),
  })
  .refine(
    (d) => {
      if (d.startDate && d.endDate) return new Date(d.startDate) <= new Date(d.endDate);
      return true;
    },
    { message: 'startDate must not be after endDate' },
  );

/** GET /api/admin/fees — returns fees_withdrawn event payloads */
export async function getFeeSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = feesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }

    const adminWallet = req.account ?? 'unknown';
    logAuditEvent({
      action: 'fee_history_query',
      adminWallet,
      queryParams: req.query as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });
    const withdrawals = queryEvents('fees_withdrawn').map((e) => e.payload as Record<string, unknown>);
    const body: ApiResponse<Record<string, unknown>[]> = { success: true, data: withdrawals };
    res.json(body);
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/validators */
export async function listValidators(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    res.json({ success: true, data: getAllValidators() });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/validators/register
 * Invokes register_validator(validator) on the Soroban contract via the
 * platform keypair. The local `validators` row is only inserted after
 * on-chain confirmation, so a failed/rejected chain call never leaves a
 * local row that doesn't reflect contract state.
 */
export async function registerValidator(req: Request, res: Response, next: NextFunction): Promise<void> {
  const adminWallet = req.account ?? 'unknown';
  const { validatorWallet } = req.body as { validatorWallet?: string };

  if (!validatorWallet || !isValidStellarAddress(validatorWallet)) {
    logger.warn(`[admin] register_validator rejected — invalid address | admin=${adminWallet} target=${validatorWallet}`);
    res.status(400).json({
      success: false,
      error: 'Validation Error',
      details: [{ field: 'validatorWallet', message: 'Invalid Stellar address' }],
      code: ErrorCode.VALIDATION_ERROR,
    });
    return;
  }

  // Multi-sig threshold check: propose when threshold > 1.
  if (!config.adminWallets.includes(adminWallet)) {
    res.status(403).json({ success: false, error: 'Insufficient permissions' });
    return;
  }

  const proposal = proposeAction('pause_contract', { validatorWallet, action: 'register_validator' }, adminWallet);
  if (proposal.status === 'proposed') {
    logAuditEvent({
      action: 'validator_registration',
      adminWallet,
      queryParams: { validatorWallet, actionId: proposal.actionId, outcome: 'multisig_pending' },
      timestamp: new Date().toISOString(),
      contractAction: 'register_validator',
    });
    res.status(202).json({
      success: true,
      message: `Validator registration proposed, awaiting ${config.adminThreshold - 1} more admin signature(s)`,
      data: { actionId: proposal.actionId, collectedSignatures: 1, requiredSignatures: config.adminThreshold },
    });
    return;
  }

  try {
    logger.info(`[admin] action=register_validator admin=${adminWallet} target=${validatorWallet}`);
    logAuditEvent({
      action: 'validator_registration',
      adminWallet,
      queryParams: { validatorWallet },
      timestamp: new Date().toISOString(),
      contractAction: 'register_validator',
    });

    const result = await registerValidatorOnChain(validatorWallet);

    // Only mutate the local row once the chain has confirmed the register.
    insertValidator(validatorWallet, result.transactionId);

    logAuditEvent({
      action: 'validator_registration',
      adminWallet,
      queryParams: { validatorWallet, transactionId: result.transactionId, outcome: 'success' },
      timestamp: new Date().toISOString(),
      contractAction: 'register_validator',
    });

    res.status(202).json({
      success: true,
      message: `Validator ${validatorWallet} registration submitted`,
      transactionId: result.transactionId,
    });
  } catch (err) {
    logAuditEvent({
      action: 'validator_registration',
      adminWallet,
      queryParams: {
        validatorWallet,
        error: err instanceof Error ? err.message : 'unknown_error',
        errorCode: err instanceof ValidatorActionError ? err.code : 'UNKNOWN',
        outcome: 'failure',
      },
      timestamp: new Date().toISOString(),
      contractAction: 'register_validator',
    });

    if (err instanceof ValidatorActionError) {
      switch (err.code) {
        case 'ALREADY_REGISTERED':
          res.status(409).json({ success: false, error: 'Validator is already registered on-chain', code: ErrorCode.CONFLICT });
          return;
        case 'UNAUTHORIZED':
          res.status(403).json({ success: false, error: 'Unauthorized to register this validator', code: ErrorCode.FORBIDDEN });
          return;
        case 'NETWORK_ERROR':
          res.status(503).json({ success: false, error: 'Network error; please retry', code: ErrorCode.NETWORK_ERROR });
          return;
      }
    }
    next(err);
  }
}

/**
 * POST /api/admin/validators/revoke
 * Invokes revoke_validator(validator) on the Soroban contract via the
 * platform keypair. The local `validators` row is only marked revoked after
 * on-chain confirmation, so a failed/rejected chain call never leaves the
 * local row out of sync with contract state.
 */
export async function revokeValidator(req: Request, res: Response, next: NextFunction): Promise<void> {
  const adminWallet = req.account ?? 'unknown';
  const { validatorWallet } = req.body as { validatorWallet?: string };

  if (!validatorWallet || !isValidStellarAddress(validatorWallet)) {
    logger.warn(`[admin] revoke_validator rejected — invalid address | admin=${adminWallet} target=${validatorWallet}`);
    res.status(400).json({ success: false, error: 'validatorWallet must be a valid Stellar address', code: ErrorCode.VALIDATION_ERROR });
    return;
  }

  // Multi-sig threshold check.
  if (!config.adminWallets.includes(adminWallet)) {
    res.status(403).json({ success: false, error: 'Insufficient permissions' });
    return;
  }

  // Short-circuit on already-revoked local state before touching the chain.
  const existing = getValidatorByWallet(validatorWallet);
  if (existing?.revoked_at != null) {
    res.status(409).json({
      success: false,
      error: `Validator ${validatorWallet} is already revoked`,
      code: ErrorCode.CONFLICT,
    });
    return;
  }

  const proposal = proposeAction('pause_contract', { validatorWallet, action: 'revoke_validator' }, adminWallet);
  if (proposal.status === 'proposed') {
    logAuditEvent({
      action: 'validator_revocation',
      adminWallet,
      queryParams: { validatorWallet, actionId: proposal.actionId, outcome: 'multisig_pending' },
      timestamp: new Date().toISOString(),
      contractAction: 'revoke_validator',
    });
    res.status(202).json({
      success: true,
      message: `Validator revocation proposed, awaiting ${config.adminThreshold - 1} more admin signature(s)`,
      data: { actionId: proposal.actionId, collectedSignatures: 1, requiredSignatures: config.adminThreshold },
    });
    return;
  }

  try {
    logger.info(`[admin] action=revoke_validator admin=${adminWallet} target=${validatorWallet}`);
    logAuditEvent({
      action: 'validator_revocation',
      adminWallet,
      queryParams: { validatorWallet },
      timestamp: new Date().toISOString(),
      contractAction: 'revoke_validator',
    });

    const result = await revokeValidatorOnChain(validatorWallet);

    // Only mutate the local row once the chain has confirmed the revoke.
    revokeValidatorRow(validatorWallet, result.transactionId);

    logAuditEvent({
      action: 'validator_revocation',
      adminWallet,
      queryParams: { validatorWallet, transactionId: result.transactionId, outcome: 'success' },
      timestamp: new Date().toISOString(),
      contractAction: 'revoke_validator',
    });

    res.status(202).json({
      success: true,
      message: `Validator ${validatorWallet} revocation submitted`,
      transactionId: result.transactionId,
    });
  } catch (err) {
    logAuditEvent({
      action: 'validator_revocation',
      adminWallet,
      queryParams: {
        validatorWallet,
        error: err instanceof Error ? err.message : 'unknown_error',
        errorCode: err instanceof ValidatorActionError ? err.code : 'UNKNOWN',
        outcome: 'failure',
      },
      timestamp: new Date().toISOString(),
      contractAction: 'revoke_validator',
    });

    if (err instanceof ValidatorActionError) {
      switch (err.code) {
        case 'ALREADY_REVOKED':
          res.status(409).json({ success: false, error: 'Validator is already revoked on-chain', code: ErrorCode.CONFLICT });
          return;
        case 'NOT_REGISTERED':
          res.status(409).json({ success: false, error: 'Wallet is not a registered validator on-chain', code: ErrorCode.CONFLICT });
          return;
        case 'UNAUTHORIZED':
          res.status(403).json({ success: false, error: 'Unauthorized to revoke this validator', code: ErrorCode.FORBIDDEN });
          return;
        case 'NETWORK_ERROR':
          res.status(503).json({ success: false, error: 'Network error; please retry', code: ErrorCode.NETWORK_ERROR });
          return;
      }
    }
    next(err);
  }
}

/**
 * POST /api/admin/contract/pause
 * Invokes pause() on the Soroban contract via the platform keypair.
 * Returns 409 if the contract is already paused.
 */
export async function pauseContract(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const adminWallet = req.account ?? 'unknown';
    // Check if admin wallet is in allowed admin wallets
    if (!config.adminWallets.includes(adminWallet)) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }
    // Check threshold for high-value operations
    const proposal = proposeAction('pause_contract', {}, adminWallet);
    if (proposal.status === 'immediate') {
      logAuditEvent({
        action: 'contract_state_change',
        adminWallet,
        queryParams: {},
        timestamp: new Date().toISOString(),
        contractAction: 'pause_contract',
      });

      const result = await pauseContractOnChain();

      logAuditEvent({
        action: 'contract_state_change',
        adminWallet,
        queryParams: { transactionId: result.transactionId, outcome: 'success' },
        timestamp: new Date().toISOString(),
        contractAction: 'pause_contract',
      });

      res.status(202).json({
        success: true,
        message: 'Contract paused successfully',
        transactionId: result.transactionId,
      });
      return;
    }
    res.status(202).json({
      success: true,
      message: `Contract pause proposed, awaiting ${config.adminThreshold - 1} more admin signature(s)`,
      data: { actionId: proposal.actionId, collectedSignatures: 1, requiredSignatures: config.adminThreshold },
    });
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === 'CONTRACT_ALREADY_PAUSED') {
      res.status(409).json({ success: false, error: 'Contract is already paused', code: ErrorCode.CONFLICT });
      return;
    }
    next(err);
  }
}

/**
 * POST /api/admin/contract/unpause
 * Invokes unpause() on the Soroban contract via the platform keypair.
 * Returns 409 if the contract is not currently paused.
 */
export async function unpauseContract(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const adminWallet = req.account ?? 'unknown';
    // Check if admin wallet is in allowed admin wallets
    if (!config.adminWallets.includes(adminWallet)) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }
    // Check threshold for high-value operations
    const proposal = proposeAction('unpause_contract', {}, adminWallet);
    if (proposal.status === 'immediate') {
      logAuditEvent({
        action: 'contract_state_change',
        adminWallet,
        queryParams: {},
        timestamp: new Date().toISOString(),
        contractAction: 'unpause_contract',
      });

      const result = await unpauseContractOnChain();

      logAuditEvent({
        action: 'contract_state_change',
        adminWallet,
        queryParams: { transactionId: result.transactionId, outcome: 'success' },
        timestamp: new Date().toISOString(),
        contractAction: 'unpause_contract',
      });

      res.status(202).json({
        success: true,
        message: 'Contract unpaused successfully',
        transactionId: result.transactionId,
      });
      return;
    }
    res.status(202).json({
      success: true,
      message: `Contract unpause proposed, awaiting ${config.adminThreshold - 1} more admin signature(s)`,
      data: { actionId: proposal.actionId, collectedSignatures: 1, requiredSignatures: config.adminThreshold },
    });
  } catch (err) {
    if (err instanceof Error && (err as { code?: string }).code === 'CONTRACT_NOT_PAUSED') {
      res.status(409).json({ success: false, error: 'Contract is not currently paused', code: ErrorCode.CONFLICT });
      return;
    }
    next(err);
  }
}

const revokeTokenSchema = z.object({
  jti: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
}).refine((d) => !!d.jti || !!d.token, { message: 'jti or token is required' });

/** POST /api/admin/tokens/revoke */
export async function revokeTokenController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = revokeTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'jti or token is required', code: ErrorCode.VALIDATION_ERROR });
      return;
    }

    const defaultExpiresAt = Math.floor(Date.now() / 1000) + 86400;
    let jti = parsed.data.jti;
    let expiresAt = defaultExpiresAt;

    if (!jti && parsed.data.token) {
      const decoded = jwt.decode(parsed.data.token) as jwt.JwtPayload | null;
      if (!decoded?.jti) {
        res.status(400).json({ success: false, error: 'Token does not contain a jti claim', code: ErrorCode.VALIDATION_ERROR });
        return;
      }
      jti = decoded.jti;
      expiresAt = decoded.exp ?? defaultExpiresAt;
    }

    revokeToken(jti as string, expiresAt);
    res.json({ success: true, data: { jti } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/introspect
 *
 * Decodes the caller's OWN bearer token (from the Authorization header) only.
 * Any `token` field in the request body is intentionally ignored — accepting
 * an arbitrary token there would let an admin introspect another user's
 * claims (#279).
 */
export async function introspectToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // requireRole('admin') has already verified this header's token.
    // Any `token` field in the request body is intentionally ignored — accepting
    // an arbitrary token there would let an admin introspect another user's
    // claims (#279).
    const callerToken = (req.headers.authorization ?? '').slice(7);
    const payload = jwt.decode(callerToken) as jwt.JwtPayload | null;
    if (!payload) {
      res.status(400).json({ success: false, error: 'Invalid or expired token', code: ErrorCode.TOKEN_INVALID });
      return;
    }

    // Revocation check — only meaningful when the token carries a jti claim.
    const revoked = payload.jti ? isTokenRevoked(payload.jti) : false;

    // A token is valid when it has not expired AND has not been revoked.
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = payload.exp !== undefined ? payload.exp <= nowSec : false;
    const valid = !expired && !revoked;

    // Human-readable ISO 8601 timestamps (supplementary — tests do not require these).
    const iatIso = payload.iat !== undefined ? new Date(payload.iat * 1000).toISOString() : undefined;
    const expIso = payload.exp !== undefined ? new Date(payload.exp * 1000).toISOString() : undefined;

    res.json({
      success: true,
      data: {
        // Fields required by existing tests — kept at the top level of data.
        sub: payload.sub,
        role: payload.role,
        iat: payload.iat,
        exp: payload.exp,
        // Supplementary fields added by this issue.
        valid,
        ...(revoked && { revoked: true }),
        ...(iatIso !== undefined && { iatIso }),
        ...(expIso !== undefined && { expIso }),
      },
    });
  } catch (err) {
    next(err);
  }
}

export const withdrawFeesSchema = z.object({
  recipient: z
    .string()
    .refine((v) => STELLAR_ADDRESS_RE.test(v), 'Invalid Stellar address'),
});

/**
 * In-process mutex: prevents concurrent fee withdrawals.
 * A withdrawal in-flight sets this to true; cleared after the call settles.
 */
let withdrawalInProgress = false;

/** Exposed for tests to reset between runs. */
export function resetWithdrawalLock(): void {
  withdrawalInProgress = false;
}

/** Exposed for tests to simulate a lock already being held. */
export function setWithdrawalLockForTesting(): void {
  withdrawalInProgress = true;
}

/** POST /api/admin/fees — withdraw accumulated platform fees */
export async function withdrawFeesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Controller-level role guard (defence-in-depth in addition to the route middleware).
  if (req.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Insufficient permissions', code: ErrorCode.FORBIDDEN });
    return;
  }

  const adminWallet = req.account ?? 'unknown';
  // Check if admin wallet is in allowed admin wallets
  if (!config.adminWallets.includes(adminWallet)) {
    res.status(403).json({ success: false, error: 'Insufficient permissions' });
    return;
  }
  // Validate the request body up front — this must happen before the
  // threshold branch below, since the single-admin path used to skip
  // validation entirely and hand an unvalidated `recipient` straight to
  // stellarWithdrawFees().
  const parsed = withdrawFeesSchema.safeParse(req.body);
  if (!parsed.success) {
    logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: { error: 'validation_failed', reason: parsed.error.errors[0]?.message },
      timestamp: new Date().toISOString(),
    });
    sendValidationError(res, parsed.error);
    return;
  }

  // Check threshold for high-value operations
  if (config.adminThreshold > 1) {
    const proposal = proposeAction('withdraw_fees', { recipient: parsed.data.recipient }, adminWallet);
    res.status(202).json({
      success: true,
      message: `Fee withdrawal proposed, awaiting ${config.adminThreshold - 1} more admin signature(s)`,
      data: { actionId: proposal.actionId, collectedSignatures: 1, requiredSignatures: config.adminThreshold, recipient: parsed.data.recipient },
    });
    return;
  }

  const { recipient } = parsed.data;

  // Concurrency guard: reject duplicate simultaneous withdrawals.
  if (withdrawalInProgress) {
    logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: { recipient, error: 'concurrent_withdrawal_rejected' },
      timestamp: new Date().toISOString(),
      contractAction: 'withdraw_fees',
    });
    res.status(409).json({ success: false, error: 'A withdrawal is already in progress', code: ErrorCode.CONFLICT });
    return;
  }

  withdrawalInProgress = true;
  try {
    const result: FeeWithdrawalResult = await stellarWithdrawFees(recipient);

    logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: {
        recipient,
        transactionId: result.transactionId,
        amount: result.amount,
        token: result.token,
        outcome: 'success',
      },
      timestamp: new Date().toISOString(),
      contractAction: 'withdraw_fees',
    });

    res.status(200).json({
      success: true,
      data: {
        transactionId: result.transactionId,
        recipient: result.recipient,
        amount: result.amount,
        token: result.token,
      },
    });
  } catch (err) {
    const errorCode = err instanceof FeeWithdrawalError ? err.code : 'UNKNOWN';
    const retryable = err instanceof FeeWithdrawalError ? err.retryable : false;

    logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: {
        recipient,
        error: err instanceof Error ? err.message : 'unknown_error',
        errorCode,
        retryable,
        outcome: 'failure',
      },
      timestamp: new Date().toISOString(),
      contractAction: 'withdraw_fees',
    });

    if (err instanceof FeeWithdrawalError) {
      switch (err.code) {
        case 'NO_FEES':
          res.status(409).json({ success: false, error: 'No fees available to withdraw', code: ErrorCode.NO_FEES });
          return;
        case 'CONTRACT_PAUSED':
          res.status(409).json({ success: false, error: 'Contract is paused; withdrawal not available', code: ErrorCode.CONTRACT_PAUSED });
          return;
        case 'INVALID_RECIPIENT':
          res.status(400).json({ success: false, error: 'Invalid recipient address', code: ErrorCode.INVALID_RECIPIENT });
          return;
        case 'NETWORK_ERROR':
          res.status(503).json({ success: false, error: 'Network error; please retry', code: ErrorCode.NETWORK_ERROR });
          return;
      }
    }
    next(err);
  } finally {
    withdrawalInProgress = false;
  }
}

const reindexSchema = z.object({
  fromLedger: z.number().int().min(0),
});

/**
 * GET /api/admin/validators/:wallet/stats
 * Returns validator stats: milestones_approved and milestones_rejected.
 */
export async function getValidatorStatsEndpoint(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const wallet = req.params.wallet;
    // Validate wallet address
    if (!isValidStellarAddress(wallet)) {
      res.status(400).json({ success: false, error: 'Invalid validator wallet address' });
      return;
    }
    const stats = getValidatorStats(wallet);
    if (stats) {
      res.json({
        success: true,
        data: {
          wallet: stats.wallet,
          milestones_approved: stats.milestones_approved,
          milestones_rejected: stats.milestones_rejected
        }
      });
    } else {
      res.json({
        success: true,
        data: {
          wallet,
          milestones_approved: 0,
          milestones_rejected: 0
        }
      });
    }
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/indexer/reindex
 * Resets the indexer's last_ledger to fromLedger so the next poll replays from that point.
 */
export async function reindex(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = reindexSchema.safeParse(req.body);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const { fromLedger } = parsed.data;
    const previous = fetchLastIndexedLedger();
    persistLastIndexedLedger(fromLedger);
    res.json({ success: true, data: { fromLedger, previous } });
  } catch (err) {
    next(err);
  }
}

const updatePlatformFeeSchema = z.object({
  platformFeeBps: z.number().int().min(0).max(10000), // 0-100% in basis points
});

/**
 * POST /api/admin/platform-fee
 * Update platform fee configuration on-chain
 */
export async function updatePlatformFee(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.role !== 'admin') {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }

    const adminWallet = req.account ?? 'unknown';
    const parsed = updatePlatformFeeSchema.safeParse(req.body);

    if (!parsed.success) {
      logAuditEvent({
        action: 'platform_fee_update_attempt',
        adminWallet,
        queryParams: { error: 'validation_failed', reason: parsed.error.errors[0]?.message },
        timestamp: new Date().toISOString(),
      });
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request body' });
      return;
    }

    const { platformFeeBps } = parsed.data;

    logger.info(`[admin] action=update_platform_fee admin=${adminWallet} platformFeeBps=${platformFeeBps}`);
    logAuditEvent({
      action: 'platform_fee_update_attempt',
      adminWallet,
      queryParams: { platformFeeBps, outcome: 'submitted' },
      timestamp: new Date().toISOString(),
      contractAction: 'set_platform_fee_bps',
    });

    // NOTE: Contract-level update is simulated. Real invocation will call set_platform_fee_bps() on the Soroban contract.
    res.status(202).json({
      success: true,
      message: `Platform fee update to ${platformFeeBps} bps submitted (simulated)`,
      transactionId: 'stub-platform-fee-txn-placeholder',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/actions/pending
 * List all pending multi-admin actions (expired ones are purged on read).
 */
export async function getPendingActions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const actions = listPendingActions().map((a) => ({
      id: a.id,
      actionType: a.action_type,
      proposer: a.proposer,
      payload: JSON.parse(a.payload),
      collectedSignatures: a.collected_signatures,
      requiredSignatures: a.required_signatures,
      expiresAt: a.expires_at,
      createdAt: a.created_at,
    }));
    res.json({ success: true, data: actions });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/actions/:id
 * Get details of a specific pending action including collected signers.
 */
export async function getPendingActionById(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const details = getActionDetails(req.params.id);
    if (!details) {
      res.status(404).json({ success: false, error: 'Action not found', code: ErrorCode.NOT_FOUND });
      return;
    }
    res.json({
      success: true,
      data: {
        id: details.action.id,
        actionType: details.action.action_type,
        proposer: details.action.proposer,
        payload: JSON.parse(details.action.payload),
        status: details.action.status,
        collectedSignatures: details.action.collected_signatures,
        requiredSignatures: details.action.required_signatures,
        expiresAt: details.action.expires_at,
        createdAt: details.action.created_at,
        signers: details.signatures.map((s) => ({ wallet: s.signer, signedAt: s.signed_at })),
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/actions/:id/approve
 * Co-sign a pending multi-admin action.
 */
export async function approvePendingAction(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const adminWallet = req.account ?? 'unknown';

    if (!config.adminWallets.includes(adminWallet)) {
      res.status(403).json({ success: false, error: 'Insufficient permissions' });
      return;
    }

    const result = approveAction(req.params.id, adminWallet);

    if (result.status === 'duplicate') {
      res.status(409).json({
        success: false,
        error: 'Admin has already signed this action',
        code: ErrorCode.CONFLICT,
        data: { actionId: result.actionId, collectedSignatures: result.collected, requiredSignatures: result.required },
      });
      return;
    }

    if (result.status === 'approved') {
      res.status(200).json({
        success: true,
        message: 'Approval threshold reached — action executed',
        data: {
          actionId: result.actionId,
          collectedSignatures: result.collected,
          requiredSignatures: result.required,
          status: 'executed',
        },
      });
      return;
    }

    res.status(202).json({
      success: true,
      message: `Signature recorded, ${result.required - result.collected} more signature(s) needed`,
      data: {
        actionId: result.actionId,
        collectedSignatures: result.collected,
        requiredSignatures: result.required,
        status: 'pending',
      },
    });
  } catch (err) {
    const error = err as Error & { code?: string; status?: number };
    if (error.status === 404) {
      res.status(404).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error.status === 410) {
      res.status(410).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error.status === 409) {
      res.status(409).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error.status === 403) {
      res.status(403).json({ success: false, error: error.message, code: error.code });
      return;
    }
    if (error.status === 400) {
      res.status(400).json({ success: false, error: error.message, code: error.code });
      return;
    }
    next(err);
  }
}

// ─── Validator import types ───────────────────────────────────────────────────

export interface ImportValidatorEntry {
  wallet: string;
  label?: string;
  region?: string;
}

export type ImportResultStatus = 'registered' | 'duplicate' | 'invalid' | 'pending_approval';

export interface ImportValidatorResult {
  wallet: string;
  status: ImportResultStatus;
  reason?: string;
  label?: string;
  region?: string;
}

/**
 * Parse a CSV text body into an array of ImportValidatorEntry objects.
 *
 * Supported formats:
 *   - Single-column:  wallet
 *   - Two-column:     wallet,label
 *   - Three-column:   wallet,label,region
 *
 * Lines beginning with # or empty lines are ignored.
 * A header row whose first token is the literal "wallet" (case-insensitive)
 * is silently skipped.
 */
export function parseCsvBody(text: string): ImportValidatorEntry[] {
  const entries: ImportValidatorEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cols = line.split(',').map((c) => c.trim());
    // Skip header row
    if (cols[0].toLowerCase() === 'wallet') continue;
    const [wallet, label, region] = cols;
    entries.push({ wallet: wallet ?? '', label: label || undefined, region: region || undefined });
  }
  return entries;
}

/**
 * Process a batch of ImportValidatorEntry items and return per-entry results.
 *
 * Multi-sig gating:
 *   - When ADMIN_THRESHOLD > 1, queues each valid row as a pending admin action
 *     instead of registering immediately on-chain. Per-row status is "pending_approval".
 *   - When ADMIN_THRESHOLD <= 1, calls registerValidatorOnChain() for each valid row
 *     with a concurrency limit of 5 simultaneous calls.
 *
 * Database mutation ordering:
 *   - DB insert (insertValidator) happens ONLY AFTER on-chain confirmation succeeds
 *   - Prevents orphaned rows that don't reflect contract state
 *   - Uses allSettled semantics so one failure doesn't abort the batch
 *
 * Duplicate detection:
 *   - A validator that already exists AND is not revoked → "duplicate"
 *   - A validator that was previously revoked is re-registered (same as single-
 *     registration, which also does INSERT OR REPLACE)
 */
export async function processBatch(
  entries: ImportValidatorEntry[],
  adminWallet: string,
): Promise<ImportValidatorResult[]> {
  const results: ImportValidatorResult[] = [];
  const seenInBatch = new Set<string>();

  // Split entries into two phases: validation, then registration/queueing
  const validatedEntries: Array<{
    entry: ImportValidatorEntry;
    index: number;
  }> = [];

  // Phase 1: Validation (fast path, synchronous)
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const { wallet, label, region } = entry;

    // Check if wallet address is valid
    if (!isValidStellarAddress(wallet)) {
      logger.warn(`[admin] import_validator rejected — invalid address | admin=${adminWallet} target=${wallet}`);
      results[i] = { wallet, status: 'invalid', reason: 'invalid Stellar address', label, region };
      continue;
    }

    // Check intra-batch duplicate
    if (seenInBatch.has(wallet)) {
      results[i] = { wallet, status: 'duplicate', reason: 'duplicate within batch', label, region };
      continue;
    }

    // Check DB for already-active (non-revoked) registration
    const existing = getValidatorByWallet(wallet);
    if (existing && existing.revoked_at === null) {
      results[i] = { wallet, status: 'duplicate', reason: 'already registered', label, region };
      seenInBatch.add(wallet);
      continue;
    }

    // Passes validation
    seenInBatch.add(wallet);
    validatedEntries.push({ entry, index: i });
  }

  // Phase 2: Registration/Queueing (async, with multi-sig gating and concurrency limit)
  if (validatedEntries.length > 0) {
    if (config.adminThreshold > 1) {
      // Multi-sig: queue each validated entry as a pending admin action
      for (const { entry, index } of validatedEntries) {
        const { wallet, label, region } = entry;
        try {
          const proposal = proposeAction(
            'bulk_validator_import',
            { wallet, label: label || undefined, region: region || undefined },
            adminWallet,
          );
          // Status depends on whether threshold was already met (immediate) or pending
          const status = proposal.status === 'immediate' ? 'registered' : 'pending_approval';
          logger.info(
            `[admin] action=import_register_validator_multisig admin=${adminWallet} target=${wallet} status=${status}`,
          );
          results[index] = {
            wallet,
            status: status as ImportResultStatus,
            label,
            region,
          };
        } catch (err) {
          logger.error(`[admin] import_validator_multisig error | admin=${adminWallet} target=${wallet} error=${err}`);
          results[index] = {
            wallet,
            status: 'invalid',
            reason: `Multi-sig queuing failed: ${err instanceof Error ? err.message : 'unknown error'}`,
            label,
            region,
          };
        }
      }
    } else {
      // Single-admin: call registerValidatorOnChain with concurrency limit of 5
      const tasks = validatedEntries.map(({ entry, index }) => {
        return async () => {
          const { wallet, label, region } = entry;
          try {
            logger.info(`[admin] action=import_register_validator admin=${adminWallet} target=${wallet}`);
            const result = await registerValidatorOnChain(wallet);

            // DB insert ONLY after on-chain confirmation succeeds
            insertValidator(wallet, result.transactionId);

            logger.info(
              `[admin] action=import_register_validator_success admin=${adminWallet} target=${wallet} txid=${result.transactionId}`,
            );
            results[index] = {
              wallet,
              status: 'registered',
              label,
              region,
            };
          } catch (err) {
            logger.error(
              `[admin] import_validator error | admin=${adminWallet} target=${wallet} error=${err instanceof Error ? err.message : 'unknown'}`,
            );
            // Do NOT insert into DB if on-chain call fails
            results[index] = {
              wallet,
              status: 'invalid',
              reason:
                err instanceof ValidatorActionError
                  ? `On-chain registration failed: ${err.code}`
                  : `On-chain registration failed: ${err instanceof Error ? err.message : 'unknown error'}`,
              label,
              region,
            };
          }
        };
      });

      // Execute with concurrency limit of 5
      await withConcurrencyLimit(tasks, 5);

      // Results are already populated by each task
    }
  }

  return results;
}

/**
 * POST /api/admin/validators/import
 *
 * Accepts either:
 *   - JSON body:  { validators: [{ wallet, label?, region? }, …] }
 *   - CSV body:   Content-Type: text/csv  with rows: wallet[,label[,region]]
 *
 * Returns a per-entry result summary so partial failures don't block the whole
 * batch. Invalid addresses and already-registered (non-revoked) validators are
 * skipped cleanly rather than erroring the request.
 *
 * @response 200 { success: true, data: { results, summary: { total, registered, duplicates, invalid } } }
 * @response 400 { success: false, error: string } - Unparseable body or no entries
 * @auth Bearer (admin role required)
 */
export async function importValidators(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const adminWallet = req.account ?? 'unknown';
    const contentType = (req.headers['content-type'] ?? '').toLowerCase();

    let entries: ImportValidatorEntry[];

    if (contentType.includes('text/csv') || contentType.includes('text/plain')) {
      // ── CSV path ──────────────────────────────────────────────────────────
      const rawBody = req.body as string;
      if (typeof rawBody !== 'string' || !rawBody.trim()) {
        res.status(400).json({ success: false, error: 'CSV body is empty', code: ErrorCode.VALIDATION_ERROR });
        return;
      }
      entries = parseCsvBody(rawBody);
    } else {
      // ── JSON path (default) ───────────────────────────────────────────────
      const jsonBody = req.body as { validators?: unknown };
      if (!jsonBody || !Array.isArray(jsonBody.validators)) {
        res.status(400).json({
          success: false,
          error: 'Request body must contain a "validators" array or use Content-Type: text/csv',
          code: ErrorCode.VALIDATION_ERROR,
        });
        return;
      }

      // Coerce each item — we accept { wallet } at minimum; label/region are optional strings
      entries = (jsonBody.validators as Array<unknown>).map((item) => {
        if (typeof item === 'string') return { wallet: item };
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          return {
            wallet: typeof obj['wallet'] === 'string' ? obj['wallet'] : '',
            label: typeof obj['label'] === 'string' ? obj['label'] : undefined,
            region: typeof obj['region'] === 'string' ? obj['region'] : undefined,
          };
        }
        return { wallet: '' };
      });
    }

    if (entries.length === 0) {
      res.status(400).json({ success: false, error: 'No validator entries found in request', code: ErrorCode.VALIDATION_ERROR });
      return;
    }

    const results = await processBatch(entries, adminWallet);

    const registered = results.filter((r) => r.status === 'registered').length;
    const pending = results.filter((r) => r.status === 'pending_approval').length;
    const duplicates = results.filter((r) => r.status === 'duplicate').length;
    const invalid = results.filter((r) => r.status === 'invalid').length;

    logger.info(
      `[admin] action=import_validators admin=${adminWallet} total=${results.length} registered=${registered} pending=${pending} duplicates=${duplicates} invalid=${invalid}`,
    );

    logAuditEvent({
      action: 'bulk_validator_import',
      adminWallet,
      queryParams: {
        total: results.length,
        registered: registered + pending,
        duplicates,
        invalid,
      },
      timestamp: new Date().toISOString(),
    });

    res.status(200).json({
      success: true,
      data: {
        results,
        summary: {
          total: results.length,
          registered: registered + pending,
          duplicates,
          invalid,
        },
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─── POST /api/admin/fees/withdraw ─────────────────────────────────────────
//
// Fully-specified fee withdrawal endpoint (replaces the stub in
// withdrawFeesController above). Key differences from the legacy endpoint:
//
//  1. Body:      { treasuryAddress, amountStroops }  (not { recipient })
//  2. Validate:  treasuryAddress via isValidStellarAddress
//                amountStroops > 0 AND ≤ on-chain get_fee_balance()
//  3. Multi-sig: if ADMIN_THRESHOLD > 1 → propose and return 202
//  4. Execute:   withdraw_fees(admin, treasury_address, amount_stroops)
//  5. DB record: fee_withdrawals row (idempotency_key, treasury_address,
//                amount_stroops, tx_hash, admin_wallet, created_at)
//  6. Audit log: fee_withdrawal event
//  7. Idempotency: Idempotency-Key header handled by the idempotency
//                  middleware applied in the route; the controller also
//                  writes to the fee_withdrawals idempotency_key column
//                  as a storage-layer guard.

const withdrawFeesV2Schema = z.object({
  treasuryAddress: z
    .string({ required_error: 'treasuryAddress is required' })
    .refine(isValidStellarAddress, {
      message: 'treasuryAddress must be a valid Stellar public key',
    }),
  amountStroops: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((v) => /^\d+$/.test(v) && BigInt(v) > 0n, {
      message: 'amountStroops must be a positive integer',
    }),
});

/**
 * POST /api/admin/fees/withdraw
 *
 * Withdraw accumulated platform fees from the Soroban contract.
 *
 * Request body: { treasuryAddress: string, amountStroops: string | number }
 * Optional header: Idempotency-Key  (prevents duplicate submissions)
 *
 * Flow:
 *  1. Role + admin-wallet guard
 *  2. Zod validation
 *  3. get_fee_balance() — reject 422 if amountStroops > balance
 *  4. Multi-sig gate — if ADMIN_THRESHOLD > 1 propose and return 202
 *  5. Concurrency lock — reject 409 if another withdrawal is in flight
 *  6. withdraw_fees() on-chain
 *  7. Insert fee_withdrawals DB record
 *  8. Audit log
 */
export async function withdrawFeesV2Controller(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // ── 1. Role guard (defence-in-depth in addition to route middleware) ───────
  if (req.role !== 'admin') {
    res.status(403).json({
      success: false,
      error: 'Insufficient permissions',
      code: ErrorCode.FORBIDDEN,
    });
    return;
  }

  const adminWallet = req.account ?? 'unknown';

  if (!config.adminWallets.includes(adminWallet)) {
    res.status(403).json({ success: false, error: 'Insufficient permissions' });
    return;
  }

  // ── 2. Zod validation ───────────────────────────────────────────────────────
  const parsed = withdrawFeesV2Schema.safeParse(req.body);
  if (!parsed.success) {
    const reason = parsed.error.errors[0]?.message ?? 'Invalid request body';
    logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: { error: 'validation_failed', reason },
      timestamp: new Date().toISOString(),
    });
    res.status(400).json({
      success: false,
      error: reason,
      code: ErrorCode.VALIDATION_ERROR,
    });
    return;
  }

  const { treasuryAddress, amountStroops } = parsed.data;

  // ── 3. Multi-sig gate ───────────────────────────────────────────────────────
  if (config.adminThreshold > 1) {
    const proposal = proposeAction(
      'withdraw_fees',
      { treasuryAddress, amountStroops },
      adminWallet,
    );
    logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: {
        treasuryAddress,
        amountStroops,
        actionId: proposal.actionId,
        outcome: 'multisig_pending',
      },
      timestamp: new Date().toISOString(),
    });
    res.status(202).json({
      success: true,
      message: `Fee withdrawal proposed, awaiting ${config.adminThreshold - 1} more admin signature(s)`,
      data: {
        actionId: proposal.actionId,
        collectedSignatures: 1,
        requiredSignatures: config.adminThreshold,
        treasuryAddress,
        amountStroops,
      },
    });
    return;
  }

  // ── 4. Validate amountStroops against live on-chain fee balance ────────────
  try {
    const balance = await getFeeBalance();
    if (BigInt(amountStroops) > balance) {
      logAuditEvent({
        action: 'fee_withdrawal_attempt',
        adminWallet,
        queryParams: {
          treasuryAddress,
          amountStroops,
          feeBalance: balance.toString(),
          error: 'amount_exceeds_balance',
          outcome: 'failure',
        },
        timestamp: new Date().toISOString(),
      });
      res.status(422).json({
        success: false,
        error: `amountStroops (${amountStroops}) exceeds the contract fee balance (${balance})`,
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }
  } catch (balanceErr) {
    // Non-fatal balance check failure — log and proceed; the contract itself
    // will reject the withdrawal if the amount is invalid.
    logger.warn(
      `[admin] fee_balance_check_failed admin=${adminWallet} err=${
        balanceErr instanceof Error ? balanceErr.message : balanceErr
      }`,
    );
  }

  // ── 5. Concurrency guard ────────────────────────────────────────────────────
  if (withdrawalInProgress) {
    logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: {
        treasuryAddress,
        amountStroops,
        error: 'concurrent_withdrawal_rejected',
        outcome: 'failure',
      },
      timestamp: new Date().toISOString(),
      contractAction: 'withdraw_fees',
    });
    res.status(409).json({
      success: false,
      error: 'A withdrawal is already in progress',
      code: ErrorCode.CONFLICT,
    });
    return;
  }

  withdrawalInProgress = true;

  // Extract idempotency key from the header (the middleware has already served
  // a cached response if the key was seen before — reaching here means it's new).
  const idempotencyKey =
    typeof req.headers['idempotency-key'] === 'string'
      ? req.headers['idempotency-key'].trim() || null
      : null;

  try {
    // ── 6. On-chain execution ─────────────────────────────────────────────────
    logger.info(
      `[admin] action=withdraw_fees admin=${adminWallet} treasury=${treasuryAddress} amount=${amountStroops}`,
    );

    const result: FeeWithdrawalResult = await stellarWithdrawFees(treasuryAddress);

    // ── 7. DB record ──────────────────────────────────────────────────────────
    try {
      insertFeeWithdrawal({
        idempotencyKey,
        treasuryAddress,
        amountStroops,
        txHash: result.transactionId,
        adminWallet,
        createdAt: new Date().toISOString(),
      });
    } catch (dbErr) {
      // DB write failure must not block the response — the on-chain transaction
      // already succeeded. Log the error so ops can reconcile manually.
      logger.error(
        `[admin] fee_withdrawal_db_insert_failed txHash=${result.transactionId} err=${
          dbErr instanceof Error ? dbErr.message : dbErr
        }`,
      );
    }

    // ── 8. Audit log ──────────────────────────────────────────────────────────
    logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: {
        treasuryAddress,
        amountStroops,
        recipient: result.recipient,
        transactionId: result.transactionId,
        amount: result.amount,
        token: result.token,
        outcome: 'success',
      },
      timestamp: new Date().toISOString(),
      contractAction: 'withdraw_fees',
    });

    res.status(200).json({
      success: true,
      data: {
        transactionId: result.transactionId,
        treasuryAddress,
        amountStroops,
        recipient: result.recipient,
        amount: result.amount,
        token: result.token,
      },
    });
  } catch (err) {
    const errorCode = err instanceof FeeWithdrawalError ? err.code : 'UNKNOWN';
    const retryable = err instanceof FeeWithdrawalError ? err.retryable : false;

    logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: {
        treasuryAddress,
        amountStroops,
        error: err instanceof Error ? err.message : 'unknown_error',
        errorCode,
        retryable,
        outcome: 'failure',
      },
      timestamp: new Date().toISOString(),
      contractAction: 'withdraw_fees',
    });

    if (err instanceof FeeWithdrawalError) {
      switch (err.code) {
        case 'NO_FEES':
          res.status(409).json({
            success: false,
            error: 'No fees available to withdraw',
            code: ErrorCode.NO_FEES,
          });
          return;
        case 'CONTRACT_PAUSED':
          res.status(409).json({
            success: false,
            error: 'Contract is paused; withdrawal not available',
            code: ErrorCode.CONTRACT_PAUSED,
          });
          return;
        case 'INVALID_RECIPIENT':
          res.status(400).json({
            success: false,
            error: 'Invalid treasury address',
            code: ErrorCode.INVALID_RECIPIENT,
          });
          return;
        case 'NETWORK_ERROR':
          res.status(503).json({
            success: false,
            error: 'Network error; please retry',
            code: ErrorCode.NETWORK_ERROR,
          });
          return;
      }
    }
    next(err);
  } finally {
    withdrawalInProgress = false;
  }
}
