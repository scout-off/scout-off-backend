import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  listWebhookDeadLetters,
  countWebhookDeadLetters,
  getWebhookDeadLetterById,
  listWebhookSubscriptions,
  markWebhookDeadLetterReplayed,
  updateWebhookDeadLetterAttempt,
  deleteWebhookDeadLetter,
  purgeOldWebhookDeadLetters,
} from '../db';
import { postWebhookWithRetry } from '../services/webhooks';
import { logger } from '../utils/logger';
import { incrementWebhookRetrySuccessTotal } from '../middleware/metrics';

/** Exported so routes can apply validateQuery(listDeadLettersQuerySchema) */
export const listDeadLettersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * GET /api/admin/webhooks/dead-letters
 *
 * Paginated list of dead letters. Each row exposes url, payload_preview
 * (first 200 chars of JSON), retry_count, last_error, and created_at.
 */
export async function listDeadLetters(req: Request, res: Response, next: NextFunction) {
  const parsed = listDeadLettersQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
    });
    return;
  }
  const { page, pageSize } = parsed.data;
  const offset = (page - 1) * pageSize;

  const rows = listWebhookDeadLetters(pageSize, offset);
  const total = countWebhookDeadLetters();

  const data = rows.map((row) => ({
    id: row.id,
    subscriptionId: row.subscription_id,
    url: row.url,
    eventType: row.event_type,
    // payload_preview: first 200 chars — enough to identify the event
    // without sending the full body in a list response.
    payloadPreview: row.payload.slice(0, 200),
    retryCount: row.attempts,
    lastError: row.failure_reason,
    status: row.status,
    createdAt: row.created_at,
    replayedAt: row.replayed_at,
  }));

  res.json({ success: true, data, total, page, pageSize });
}

// ─── Param validation ─────────────────────────────────────────────────────────

const deadLetterIdSchema = z.object({
  id: z.coerce.number().int().positive('id must be a positive integer'),
});

// ─── POST /api/admin/webhooks/dead-letters/:id/requeue ────────────────────────

/**
 * POST /api/admin/webhooks/dead-letters/:id/requeue
 *
 * Manually trigger a retry for a specific dead letter.
 * Re-signs the payload with the subscription's current secret.
 */
export async function requeueDeadLetter(req: Request, res: Response, next: NextFunction) {
try {
    const parsedParams = deadLetterIdSchema.safeParse(req.params);
    if (!parsedParams.success) {
      res.status(400).json({
        success: false,
        error: parsedParams.error.errors[0]?.message ?? 'Invalid id',
      });
      return;
    }
    const { id } = parsedParams.data;

    const deadLetter = getWebhookDeadLetterById(id);
    if (!deadLetter) {
      res.status(404).json({ success: false, error: 'Dead-lettered delivery not found' });
      return;
    }
    if (deadLetter.status === 'replayed') {
      res.status(409).json({ success: false, error: 'Delivery has already been replayed' });
      return;
    }

    const subscriptions = listWebhookSubscriptions();
    const subscription =
      subscriptions.find((s) => s.id === deadLetter.subscription_id) ??
      subscriptions.find((s) => s.url === deadLetter.url);

    try {
      await postWebhookWithRetry(deadLetter.url, JSON.parse(deadLetter.payload), {
        retries: 3,
        baseDelayMs: 500,
        maxDelayMs: 5000,
        secret: subscription?.secret,
      });

      markWebhookDeadLetterReplayed(id);
      incrementWebhookRetrySuccessTotal();

      res.json({
        success: true,
        message: 'Webhook delivery requeued and delivered successfully',
        data: { id, status: 'replayed' },
      });
    } catch (err) {
      const failureReason = err instanceof Error ? err.message : String(err);
      const attempts = deadLetter.attempts + 3;
      updateWebhookDeadLetterAttempt(id, attempts, failureReason);
      logger.warn(
        `[webhooks] manual requeue failed — id=${id} url=${deadLetter.url} reason=${failureReason}`,
      );
      res.status(502).json({
        success: false,
        message: 'Requeue attempt failed; delivery remains dead-lettered',
        error: failureReason,
        data: { id, status: 'pending', retryCount: attempts },
      });
    }
  } catch (err) {
    next(err);
  }
}

// ─── DELETE /api/admin/webhooks/dead-letters/:id ──────────────────────────────

/**
 * DELETE /api/admin/webhooks/dead-letters/:id
 *
 * Purge a specific dead-letter row.
 */
export async function purgeDeadLetter(req: Request, res: Response, next: NextFunction) {
  const parsedParams = deadLetterIdSchema.safeParse(req.params);
  if (!parsedParams.success) {
    res.status(400).json({
      success: false,
      error: parsedParams.error.errors[0]?.message ?? 'Invalid id',
    });
    return;
  }
  const { id } = parsedParams.data;

  const deleted = deleteWebhookDeadLetter(id);
  if (!deleted) {
    res.status(404).json({ success: false, error: 'Dead-lettered delivery not found' });
    return;
  }

  res.json({ success: true, message: 'Dead letter purged', data: { id } });
}

// ─── DELETE /api/admin/webhooks/dead-letters ──────────────────────────────────

const purgeOldQuerySchema = z.object({
  olderThanDays: z.coerce.number().int().min(1).default(7),
});

/**
 * DELETE /api/admin/webhooks/dead-letters
 *
 * Purge all dead letters older than `olderThanDays` days (default: 7).
 */
export async function purgeOldDeadLetters(req: Request, res: Response, next: NextFunction) {
  const parsed = purgeOldQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
    });
    return;
  }
  const { olderThanDays } = parsed.data;

  const deleted = purgeOldWebhookDeadLetters(olderThanDays);
  res.json({
    success: true,
    message: `Purged ${deleted} dead letter(s) older than ${olderThanDays} day(s)`,
    data: { deleted, olderThanDays },
  });
}

// ─── Legacy replay alias (kept for backwards compatibility) ──────────────────

/**
 * POST /api/admin/webhooks/:id/replay
 *
 * Kept for backwards compatibility. Delegates to requeueDeadLetter.
 */
export { requeueDeadLetter as replayDeadLetter };
