import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getWebhookDeliveries, getWebhookDeliverySummary } from '../db';
import { ErrorCode } from '../utils/errorCodes';


const webhookDeliveryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  windowMs: z.coerce.number().int().min(1).optional(),
});

/**
 * GET /api/admin/webhooks/:id/deliveries
 *
 * Returns paginated delivery-attempt records for a given webhook subscription.
 * `:id` is the subscription identifier (URL-encoded endpoint URL).
 */
export async function getWebhookDeliveriesEndpoint(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const subscriptionId = decodeURIComponent(req.params.id as string);
    const parsed = webhookDeliveryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }
    const { limit, offset } = parsed.data;
    const { data, total } = getWebhookDeliveries({ subscriptionId, limit, offset });
    res.json({ success: true, data, total, limit, offset });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/webhooks/:id/summary
 *
 * Returns a rolled-up success-rate summary for a subscription over a time window.
 */
export async function getWebhookDeliverySummaryEndpoint(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const subscriptionId = decodeURIComponent(req.params.id as string);
    const parsed = webhookDeliveryQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        error: parsed.error.errors[0]?.message ?? 'Invalid query parameters',
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }
    const windowMs = parsed.data.windowMs ?? 24 * 60 * 60 * 1000;
    const summary = getWebhookDeliverySummary(subscriptionId, windowMs);
    res.json({ success: true, data: summary });
  } catch (err) {
    next(err);
  }
}
