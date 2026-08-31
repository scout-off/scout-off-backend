import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { getEvents, getLastLedger, setLastLedger } from '../db';
import { ApiResponse, EventRecord } from '../types';
import { logAuditEvent } from '../services/audit';
import { withdrawFees as stellarWithdrawFees, FeeWithdrawalError, FeeWithdrawalResult } from '../services/stellar';
import { executeAdminAction } from '../services/adminMultiSig';
import config from '../config';
import { logger } from '../utils/logger';

const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/** GET /api/admin/stats */
export async function getStats(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      success: true,
      data: {
        players: getEvents('player_registered').length,
        milestones: getEvents('milestone_approved').length,
        subscriptions: getEvents('scout_subscribed').length,
        events: getEvents().length,
      },
    });
  } catch (err) {
    next(err);
  }
}

const isoDateString = z
  .string()
  .refine((v) => !isNaN(Date.parse(v)), { message: 'Must be a valid ISO 8601 date string' })
  .transform((v) => new Date(v));

/** Exported so routes can apply validateQuery(adminDateRangeSchema) */
export const adminDateRangeSchema = z.object({
  startDate: isoDateString.optional(),
  endDate: isoDateString.optional(),
  eventType: z.string().optional(),
}).refine(
  (d) => !(d.startDate && d.endDate && d.startDate > d.endDate),
  { message: 'startDate must not be after endDate' }
);

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

/** GET /api/admin/events */
export async function getAllEvents(req: Request, res: Response, next: NextFunction) {
  try {
    const dateResult = adminDateRangeSchema.safeParse(req.query);
    if (!dateResult.success) {
      res.status(400).json({ success: false, error: dateResult.error.errors[0]?.message ?? 'Invalid query parameters' });
      return;
    }
    const pageResult = paginationSchema.safeParse(req.query);
    if (!pageResult.success) {
      res.status(400).json({ success: false, error: pageResult.error.errors[0]?.message ?? 'Invalid pagination parameters' });
      return;
    }
    const { startDate, endDate, eventType } = dateResult.data;
    const { limit: requestedLimit, offset: requestedOffset, page, pageSize } = pageResult.data;
    const limit = requestedLimit ?? pageSize ?? 20;
    const offset = requestedOffset ?? ((page ?? 1) - 1) * limit;

    const eventTypeFilter = eventType as ContractEventType | undefined;
    let events = getEvents(eventTypeFilter, { limit, offset }) as unknown as EventRecord[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (startDate) events = events.filter((e: any) => new Date(e.timestamp ?? e.created_at ?? 0) >= startDate!);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (endDate) events = events.filter((e: any) => new Date(e.timestamp ?? e.created_at ?? 0) <= endDate!);

    const total = getEventsCount(eventTypeFilter);
    res.json({ success: true, data: events, total, limit, offset });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/fees — returns fees_withdrawn event payloads */
export async function getFeeSummary(req: Request, res: Response, next: NextFunction) {
  try {
    const dateResult = adminDateRangeSchema.safeParse(req.query);
    if (!dateResult.success) {
      res.status(400).json({ success: false, error: dateResult.error.errors[0]?.message ?? 'Invalid query parameters' });
      return;
    }
    const adminWallet = req.account ?? 'unknown';
    logAuditEvent({
      action: 'fee_history_query',
      adminWallet,
      queryParams: req.query as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });
    const withdrawals = getEvents('fees_withdrawn').map((e) => e.payload as Record<string, unknown>);
    const body: ApiResponse<Record<string, unknown>[]> = { success: true, data: withdrawals };
    res.json(body);
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/validators/register */
export async function registerValidator(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = req.account ?? 'unknown';
    const { validatorWallet } = req.body as { validatorWallet?: string };

    if (!validatorWallet || !STELLAR_ADDRESS_RE.test(validatorWallet)) {
      logger.warn(`[admin] register_validator rejected — invalid address | admin=${adminWallet} target=${validatorWallet}`);
      res.status(400).json({ success: false, error: 'validatorWallet must be a valid Stellar address' });
      return;
    }

    logger.info(`[admin] action=register_validator admin=${adminWallet} target=${validatorWallet}`);
    // TODO: invoke register_validator on Soroban contract
    res.status(202).json({ success: true, message: `Validator ${validatorWallet} registration submitted` });
  } catch (err) {
    next(err);
  }
}

/** POST /api/admin/validators/revoke */
export async function revokeValidator(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = req.account ?? 'unknown';
    const { validatorWallet } = req.body as { validatorWallet?: string };

    if (!validatorWallet || !STELLAR_ADDRESS_RE.test(validatorWallet)) {
      logger.warn(`[admin] revoke_validator rejected — invalid address | admin=${adminWallet} target=${validatorWallet}`);
      res.status(400).json({ success: false, error: 'validatorWallet must be a valid Stellar address' });
      return;
    }

    logger.info(`[admin] action=revoke_validator admin=${adminWallet} target=${validatorWallet}`);
    // TODO: invoke revoke_validator on Soroban contract
    res.status(202).json({ success: true, message: `Validator ${validatorWallet} revocation submitted` });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/contract/pause
 * Stub: signals intent to pause the Soroban contract. Contract-level behavior is simulated.
 */
export async function pauseContract(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = req.account ?? 'unknown';
    logAuditEvent({
      action: 'contract_state_change',
      adminWallet,
      queryParams: {},
      timestamp: new Date().toISOString(),
      contractAction: 'pause_contract',
    });
    // NOTE: Contract-level pause is simulated. Real invocation will call pause() on the Soroban contract.
    res.status(202).json({
      success: true,
      message: 'Contract pause submitted (simulated)',
      transactionId: 'stub-pause-txn-placeholder',
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/admin/contract/unpause
 * Stub: signals intent to unpause the Soroban contract. Contract-level behavior is simulated.
 */
export async function unpauseContract(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = req.account ?? 'unknown';
    logAuditEvent({
      action: 'contract_state_change',
      adminWallet,
      queryParams: {},
      timestamp: new Date().toISOString(),
      contractAction: 'unpause_contract',
    });
    // NOTE: Contract-level unpause is simulated. Real invocation will call unpause() on the Soroban contract.
    res.status(202).json({
      success: true,
      message: 'Contract unpause submitted (simulated)',
      transactionId: 'stub-unpause-txn-placeholder',
    });
  } catch (err) {
    next(err);
  }
}

const introspectSchema = z.object({
  token: z.string().min(1, 'token is required'),
});

/** POST /api/admin/introspect */
export async function introspectToken(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = introspectSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0].message });
      return;
    }

    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(parsed.data.token, config.jwtSecret) as jwt.JwtPayload;
    } catch {
      res.status(400).json({ success: false, error: 'Invalid or expired token' });
      return;
    }

    // Return only non-secret metadata fields
    res.json({
      success: true,
      data: {
        sub: payload.sub,
        role: payload.role,
        iat: payload.iat,
        exp: payload.exp,
      },
    });
  } catch (err) {
    next(err);
  }
}

const STELLAR_ADDRESS_RE_PUBLIC = /^G[A-Z2-7]{55}$/;

export const withdrawFeesSchema = z.object({
  recipient: z
    .string()
    .regex(STELLAR_ADDRESS_RE_PUBLIC, 'recipient must be a valid Stellar public key'),
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
export async function withdrawFeesController(req: Request, res: Response, next: NextFunction) {
  // Controller-level role guard (defence-in-depth in addition to the route middleware).
  if (req.role !== 'admin') {
    res.status(403).json({ success: false, error: 'Insufficient permissions' });
    return;
  }

  const adminWallet = req.account ?? 'unknown';
  const parsed = withdrawFeesSchema.safeParse(req.body);

  if (!parsed.success) {
    logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: { error: 'validation_failed', reason: parsed.error.errors[0]?.message },
      timestamp: new Date().toISOString(),
    });
    res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request body' });
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
    res.status(409).json({ success: false, error: 'A withdrawal is already in progress' });
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
          res.status(409).json({ success: false, error: 'No fees available to withdraw' });
          return;
        case 'CONTRACT_PAUSED':
          res.status(409).json({ success: false, error: 'Contract is paused; withdrawal not available' });
          return;
        case 'INVALID_RECIPIENT':
          res.status(400).json({ success: false, error: 'Invalid recipient address' });
          return;
        case 'NETWORK_ERROR':
          res.status(503).json({ success: false, error: 'Network error; please retry' });
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
 * POST /api/admin/indexer/reindex
 * Resets the indexer's last_ledger to fromLedger so the next poll replays from that point.
 */
export async function reindex(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = reindexSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'fromLedger must be a non-negative integer' });
      return;
    }
    const { fromLedger } = parsed.data;
    const previous = getLastLedger();
    setLastLedger(fromLedger);
    res.json({ success: true, data: { fromLedger, previous } });
  } catch (err) {
    next(err);
  }
}

const STELLAR_ADDRESS_RE_BULK = /^G[A-Z2-7]{55}$/;

export const bulkValidatorImportSchema = z.object({
  actionId: z.string().min(1),
  wallets: z
    .array(z.string().regex(STELLAR_ADDRESS_RE_BULK, 'Each wallet must be a valid Stellar address'))
    .min(1, 'wallets must contain at least one address')
    .max(100, 'wallets may contain at most 100 addresses per batch'),
});

/**
 * POST /api/admin/validators/bulk-import
 *
 * Propose and execute an atomic bulk validator import as a single multi-sig action.
 * All wallets are processed together; partial success is reported via a manifest.
 */
export async function bulkValidatorImport(req: Request, res: Response, next: NextFunction) {
  try {
    const adminWallet = req.account ?? 'unknown';
    const parsed = bulkValidatorImportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request body' });
      return;
    }

    const { actionId, wallets } = parsed.data;
    logger.info(`[admin] action=bulk_validator_import actionId=${actionId} count=${wallets.length} admin=${adminWallet}`);

    const result = await executeAdminAction(
      actionId,
      'bulk_validator_import',
      { wallets },
      adminWallet,
    );

    if (!result.success) {
      // Partial failure — 207 Multi-Status with manifest for retry
      res.status(207).json({ success: false, error: result.error, data: { manifest: result.manifest } });
      return;
    }

    res.status(202).json({ success: true, data: { actionId, manifest: result.manifest } });
  } catch (err) {
    next(err);
  }
}
