/**
 * reindexController.ts
 *
 * Handlers for the admin reindex API:
 *   POST /api/admin/reindex         — start a background backfill job
 *   GET  /api/admin/reindex/status  — poll live progress
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  startReindex,
  getReindexStatus,
  cancelReindex,
  MAX_REINDEX_RANGE,
  ReindexAlreadyRunningError,
} from '../services/reindexService';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';

// ── Validation ────────────────────────────────────────────────────────────────

export const reindexBodySchema = z
  .object({
    fromLedger: z
      .number({ required_error: 'fromLedger is required' })
      .int('fromLedger must be an integer')
      .min(0, 'fromLedger must be ≥ 0'),
    toLedger: z
      .number({ required_error: 'toLedger is required' })
      .int('toLedger must be an integer')
      .min(1, 'toLedger must be ≥ 1'),
  })
  .strict()
  .refine((d) => d.fromLedger < d.toLedger, {
    message: 'fromLedger must be less than toLedger',
    path: ['fromLedger'],
  })
  .refine((d) => d.toLedger - d.fromLedger <= MAX_REINDEX_RANGE, {
    // Formatted with a space thousands separator ("10 000") to match the
    // classification check below, which looks for that exact substring to
    // tell a range-too-large error (→ 422) apart from other validation
    // failures (→ 400).
    message: 'Ledger range must not exceed 10 000 ledgers',
    path: ['toLedger'],
  });

// ── POST /api/admin/reindex ───────────────────────────────────────────────────

/**
 * Trigger a background event backfill for a specific ledger range.
 *
 * Validation:
 *   - fromLedger must be < toLedger
 *   - Range must be ≤ 10 000 ledgers → HTTP 422
 *   - A job already running → HTTP 409
 *
 * @body { fromLedger: number, toLedger: number }
 * @response 202 { success: true, data: { fromLedger, toLedger, status: 'running' } }
 * @response 409 { success: false, error: string } - job already running
 * @response 422 { success: false, error: string } - range > 10 000 or fromLedger ≥ toLedger
 * @auth Bearer (admin role required)
 */
export function triggerReindex(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
try {
    const parsed = reindexBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      const isRangeError =
        firstError?.message?.includes('10 000') ||
        firstError?.message?.includes('fromLedger must be less than');
      const statusCode = isRangeError ? 422 : 400;
      res.status(statusCode).json({
        success: false,
        error: firstError?.message ?? 'Invalid request body',
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    const { fromLedger, toLedger } = parsed.data;
    const adminWallet = req.account ?? 'unknown';

    logger.info(
      `[reindex] admin=${adminWallet} triggered reindex fromLedger=${fromLedger} toLedger=${toLedger}`,
    );

    startReindex(fromLedger, toLedger, adminWallet);

    res.status(202).json({
      success: true,
      data: {
        fromLedger,
        toLedger,
        status: 'running',
      },
    });
  } catch (err) {
    if (err instanceof ReindexAlreadyRunningError) {
      res.status(409).json({
        success: false,
        error: err.message,
        code: ErrorCode.CONFLICT,
      });
      return;
    }
    next(err);
  }
}

// ── GET /api/admin/reindex/status ─────────────────────────────────────────────

/**
 * Return the current state of the background reindex job.
 *
 * @response 200 {
 *   success: true,
 *   data: {
 *     status: 'idle' | 'running' | 'complete' | 'error',
 *     ledgers_processed: number,
 *     ledgers_total: number,
 *     events_inserted: number,
 *     started_at: string | null,
 *     completed_at: string | null,
 *     error_message: string | null
 *   }
 * }
 * @auth Bearer (admin role required)
 */
export function reindexStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const s = getReindexStatus();
  res.json({
    success: true,
    data: {
      status: s.status,
      from_ledger: s.fromLedger,
      to_ledger: s.toLedger,
      ledgers_processed: s.ledgersProcessed,
      ledgers_total: s.ledgersTotal,
      events_inserted: s.eventsInserted,
      started_at: s.startedAt,
      completed_at: s.completedAt,
      error_message: s.errorMessage,
    },
  });
}

// ── POST /api/admin/reindex/cancel ────────────────────────────────────────────

/**
 * Cooperatively cancel the currently running background reindex job.
 *
 * Sets a module-level cancel flag that the batch loop checks after each
 * batch. The job transitions to 'cancelled' within one batch iteration and
 * persists the last-processed ledger for auditing.
 *
 * NOTE: This is a process-local flag. For multi-instance deployments a shared
 * flag (e.g. Redis) would be required — this is labelled as a first step.
 *
 * @response 200 { success: true, data: { status: 'cancel_requested', message } }
 * @response 409 { success: false, error: string } - no job is running
 * @auth Bearer (admin role required)
 */
export function cancelReindexHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  try {
    const adminWallet = req.account ?? 'unknown';
    const wasCancelled = cancelReindex(adminWallet);

    if (!wasCancelled) {
      res.status(409).json({
        success: false,
        error: 'No reindex job is currently running.',
        code: ErrorCode.CONFLICT,
      });
      return;
    }

    logger.info(`[reindex] cancel acknowledged by admin=${adminWallet}`);

    res.json({
      success: true,
      data: {
        status: 'cancel_requested',
        message:
          'Cancellation requested. The job will stop after the current batch completes.',
      },
    });
  } catch (err) {
    next(err);
  }
}
