import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { fetchLastIndexedLedger, persistLastIndexedLedger } from '../db';
import { ErrorCode } from '../utils/errorCodes';
import { sendValidationError } from './adminControllerUtils';

export const reindexSchema = z.object({
  fromLedger: z.number().int().min(0),
}).strict();


/**
 * POST /api/admin/indexer/reindex
 * Resets the indexer's last_ledger to fromLedger so the next poll replays from that point.
 */
export async function reindex(req: Request, res: Response, next: NextFunction): Promise<void> {
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
