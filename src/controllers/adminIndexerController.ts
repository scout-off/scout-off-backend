import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  fetchLastIndexedLedger,
  persistLastIndexedLedger,
  listUnprocessedEvents,
} from '../db';
import { replayUnprocessedEvent } from '../services/indexer';
import { ErrorCode } from '../utils/errorCodes';
import { sendValidationError } from './adminControllerUtils';

export const reindexSchema = z.object({
  fromLedger: z.number().int().min(0),
}).strict();


/**
 * POST /api/admin/indexer/reindex
 * Resets the indexer's last_ledger to fromLedger so the next poll replays from that point.
 */
export async function reindex(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const parsed = reindexSchema.safeParse(req.body);
  if (!parsed.success) {
    sendValidationError(res, parsed.error);
    return;
  }
  const { fromLedger } = parsed.data;
  const previous = fetchLastIndexedLedger();
  persistLastIndexedLedger(fromLedger);
  res.json({ success: true, data: { fromLedger, previous } });
}

// ─── Unprocessed indexer events (#1540) ─────────────────────────────────────

/** Query schema for the paginated unprocessed-events listing. */
export const listUnprocessedQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  reason: z.enum(['unknown_type', 'decode_error']).optional(),
});

/**
 * GET /api/admin/indexer/unprocessed
 *
 * Paginated list of contract events the indexer could not apply (unknown topic
 * or decode failure), newest first. Each row exposes the raw topic/value XDR
 * needed to replay the event once the decoder is fixed.
 */
export async function listUnprocessed(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsed = listUnprocessedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }
    const { page, pageSize, reason } = parsed.data;
    const offset = (page - 1) * pageSize;

    const { data, total } = await listUnprocessedEvents({ limit: pageSize, offset, reason });
    const events = data.map((row) => ({
      id: row.id,
      type: row.type,
      ledger: row.ledger,
      txHash: row.tx_hash,
      eventIndex: row.event_index,
      contractId: row.contract_id,
      reason: row.reason,
      payloadPreview: row.payload ? row.payload.slice(0, 200) : null,
      createdAt: row.created_at,
    }));

    res.json({ success: true, data: events, total, page, pageSize });
  } catch (err) {
    next(err);
  }
}

// ─── Param validation ─────────────────────────────────────────────────────────

const unprocessedIdSchema = z.object({
  id: z.coerce.number().int().positive('id must be a positive integer'),
});

/**
 * POST /api/admin/indexer/unprocessed/:id/retry
 *
 * Reruns the indexer's apply path for a stored unprocessed event after a
 * decoder fix. On success the unprocessed row is removed; on failure it is
 * kept and the reason is reported back.
 */
export async function retryUnprocessed(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const parsedParams = unprocessedIdSchema.safeParse(req.params);
    if (!parsedParams.success) {
      sendValidationError(res, parsedParams.error);
      return;
    }
    const { id } = parsedParams.data;

    const result = await replayUnprocessedEvent(id);
    if (result.status === 'not_found') {
      res.status(404).json({
        success: false,
        error: `Unprocessed event ${id} not found`,
        code: ErrorCode.NOT_FOUND,
      });
      return;
    }

    res.json({
      success: true,
      data: { id, status: result.status, detail: result.detail ?? null },
    });
  } catch (err) {
    next(err);
  }
}
