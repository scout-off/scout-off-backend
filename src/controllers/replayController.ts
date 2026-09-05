/**
 * replayController.ts
 *
 * Handlers for the admin replay API:
 *   POST /api/admin/events/replay — targeted event replay for small ranges
 */

import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  runReplay,
  getReplayStatus,
  MAX_REPLAY_RANGE,
  ReplayAlreadyRunningError,
} from '../services/replayService';
import { logger } from '../utils/logger';
import { ErrorCode } from '../utils/errorCodes';

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Structural body schema (field types only, no cross-field range rules).
 * Route-level validateBody() uses this so malformed payloads 400 but range
 * violations pass through to triggerReplay(), which classifies an over-limit
 * range as 422.
 */
export const replayBodyShapeSchema = z
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
  .strict();

export const replayBodySchema = replayBodyShapeSchema
  .refine((d) => d.fromLedger < d.toLedger, {
    message: 'fromLedger must be less than toLedger',
    path: ['fromLedger'],
  })
  .refine((d) => d.toLedger - d.fromLedger < MAX_REPLAY_RANGE, {
    message: `Ledger range must be less than ${MAX_REPLAY_RANGE} ledgers`,
    path: ['toLedger'],
  });

// ── POST /api/admin/events/replay ─────────────────────────────────────────────

/**
 * Trigger a targeted event replay for a small ledger range.
 *
 * This endpoint re-fetches and upserts events for the specified range
 * without modifying the main indexer cursor. It enforces a maximum range
 * of 200 ledgers to ensure quick completion.
 *
 * Validation:
 *   - fromLedger must be < toLedger
 *   - Range must be < 200 ledgers → HTTP 422
 *   - A job already running → HTTP 409
 *
 * @body { fromLedger: number, toLedger: number }
 * @response 200 { success: true, data: { fromLedger, toLedger, eventsInserted } }
 * @response 409 { success: false, error: string } - job already running
 * @response 422 { success: false, error: string } - range ≥ 200 or fromLedger ≥ toLedger
 * @auth Bearer (admin role required)
 */
export async function triggerReplay(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = replayBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0];
      const isRangeError =
        firstError?.message?.includes('200') ||
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
      `[replay] admin=${adminWallet} triggered replay fromLedger=${fromLedger} toLedger=${toLedger}`,
    );

    const result = await runReplay(fromLedger, toLedger, adminWallet);

    if (result.error) {
      res.status(500).json({
        success: false,
        error: result.error,
        code: ErrorCode.INTERNAL_SERVER_ERROR,
      });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        fromLedger,
        toLedger,
        eventsInserted: result.eventsInserted,
      },
    });
  } catch (err) {
    if (err instanceof ReplayAlreadyRunningError) {
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

// ── GET /api/admin/events/replay/status ───────────────────────────────────────

/**
 * Return the current state of the replay job.
 *
 * @response 200 {
 *   success: true,
 *   data: {
 *     status: 'idle' | 'running' | 'complete' | 'error',
 *     from_ledger: number,
 *     to_ledger: number,
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
export function replayStatusHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const s = getReplayStatus();
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
