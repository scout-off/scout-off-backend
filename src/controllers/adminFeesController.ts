import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { queryEvents, insertFeeWithdrawal } from '../db';
import { isValidStellarAddress } from '../utils/stellarAddress';
import { STELLAR_ADDRESS_RE } from '../utils/validators';
import { logAuditEvent } from '../services/audit';
import {
  withdrawFees as stellarWithdrawFees,
  FeeWithdrawalError,
  type FeeWithdrawalResult,
  getFeeBalance,
} from '../services/stellar';
import config from '../config';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';
import { proposeAction } from '../services/adminMultiSig';
import type { ApiResponse } from '../types';
import { sendValidationError } from './adminControllerUtils';

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
  const parsed = feesQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }

  const adminWallet = req.account ?? 'unknown';
  await logAuditEvent({
    action: 'fee_history_query',
    adminWallet,
    queryParams: req.query as Record<string, unknown>,
    timestamp: new Date().toISOString(),
  }).catch(() => {});
  const withdrawals = queryEvents('fees_withdrawn').map((e) => e.payload as Record<string, unknown>);
  const body: ApiResponse<Record<string, unknown>[]> = { success: true, data: withdrawals };
  res.json(body);
}

export const withdrawFeesSchema = z.object({
  recipient: z
    .string()
    .refine((v) => STELLAR_ADDRESS_RE.test(v), 'Invalid Stellar address'),
}).strict();

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
    await logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: { error: 'validation_failed', reason: parsed.error.errors[0]?.message },
      timestamp: new Date().toISOString(),
    }).catch(() => {});
    sendValidationError(res, parsed.error);
    return;
  }

  // Check threshold for high-value operations
  if (config.adminThreshold > 1) {
    const proposal = await proposeAction('withdraw_fees', { recipient: parsed.data.recipient }, adminWallet);
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
    await logAuditEvent({
      action: 'fee_withdrawal_attempt',
      adminWallet,
      queryParams: { recipient, error: 'concurrent_withdrawal_rejected' },
      timestamp: new Date().toISOString(),
      contractAction: 'withdraw_fees',
    }).catch(() => {});
    res.status(409).json({ success: false, error: 'A withdrawal is already in progress', code: ErrorCode.CONFLICT });
    return;
  }

  withdrawalInProgress = true;
  try {
    const result: FeeWithdrawalResult = await stellarWithdrawFees(recipient);

    await logAuditEvent({
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
    }).catch(() => {});

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

    await logAuditEvent({
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
    }).catch(() => {});

    if (err instanceof FeeWithdrawalError) {
      switch (err.code) {
        case 'NO_FEES':
          res.status(409).json({ success: false, error: 'No fees available to withdraw', code: ErrorCode.NO_FEES });
          return;
        case 'INSUFFICIENT_FEES':
          // Legacy path withdraws the full balance, so this only happens when
          // the live balance dropped after the amount was resolved — the
          // requested (full) amount is no longer available.
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

export const withdrawFeesV2Schema = z.object({
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
}).strict();

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
    const proposal = await proposeAction(
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

    const result: FeeWithdrawalResult = await stellarWithdrawFees(treasuryAddress, amountStroops);

    // ── 7. DB record ──────────────────────────────────────────────────────────
    // amount_stroops stores the ACTUAL on-chain-confirmed amount (parsed from
    // the transaction result by the stellar service), NOT the requested value:
    // the DB is the record of what actually left the contract. The requested
    // amountStroops is preserved in the audit log below, so the two can be
    // reconciled — they normally match, but if the live balance dropped
    // between validation and execution the contract enforces the lower amount
    // and the DB reflects reality while the audit log keeps the request.
    try {
      insertFeeWithdrawal({
        idempotencyKey,
        treasuryAddress,
        amountStroops: result.amount,
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
    // Carries BOTH the requested amount (amountStroops) and the actual
    // on-chain-confirmed amount (amount, parsed from the tx result) so the
    // audit trail reflects what was actually withdrawn, and so the requested
    // vs actual discrepancy is preserved for reconciliation against the
    // fee_withdrawals row.
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
        case 'INSUFFICIENT_FEES':
          res.status(422).json({
            success: false,
            error: 'Requested withdrawal amount exceeds the available fee balance',
            code: ErrorCode.VALIDATION_ERROR,
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
