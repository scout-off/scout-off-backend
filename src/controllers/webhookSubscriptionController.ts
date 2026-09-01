/**
 * Webhook Subscription Management Controller (#806)
 *
 * Allows scouts to self-register, list, delete, and test webhook endpoints
 * for receiving event notifications. Each subscription is scoped to the
 * owning scout wallet; a scout cannot read or delete another scout's hooks.
 *
 * Secret handling:
 *  - Generated randomly (crypto.randomBytes(32)) on registration.
 *  - Encrypted at rest via webhookSecretCipher before DB storage.
 *  - Returned in plaintext exactly once (the 201 response).
 *  - Subsequent GET responses show a masked value: "sha256:****<last4>".
 */
import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import fetch from 'node-fetch';
import {
  createWebhookSubscription,
  getWebhookSubscriptionsByScout,
  getWebhookSubscriptionById,
  deleteWebhookSubscription,
} from '../db';
import { decryptWebhookSecret } from '../utils/webhookSecretCipher';
import { signWebhookPayload } from '../services/webhooks';
import { sendForbidden } from '../utils/authError';
import { logger } from '../utils/logger';
import type { ContractEventType } from '../types';

// ─── Known event types ────────────────────────────────────────────────────────

export const KNOWN_EVENT_TYPES: readonly ContractEventType[] = [
  'player_registered',
  'milestone_submitted',
  'milestone_approved',
  'scout_subscribed',
  'contact_unlocked',
  'trial_offer_logged',
  'trial_offer_accepted',
  'trial_offer_rejected',
  'fees_withdrawn',
] as const;

// ─── Validation schemas ───────────────────────────────────────────────────────

export const registerWebhookSchema = z.object({
  url: z
    .string()
    .url('url must be a valid HTTP/HTTPS URL')
    .refine((u) => u.startsWith('http://') || u.startsWith('https://'), {
      message: 'url must use http or https protocol',
    }),
  eventTypes: z
    .array(z.enum(KNOWN_EVENT_TYPES as [ContractEventType, ...ContractEventType[]]))
    .min(1, 'eventTypes must contain at least one event type')
    .optional(),
}).strict();

export type RegisterWebhookRequest = z.infer<typeof registerWebhookSchema>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Mask a plaintext secret for safe display in list responses. */
function maskSecret(plaintext: string): string {
  return `sha256:****${plaintext.slice(-4)}`;
}

function serializeSubscription(
  row: { id: number; url: string; secret: string; event_types: string | null; created_at: string },
  opts: { revealSecret?: boolean } = {},
) {
  const plaintext = decryptWebhookSecret(row.secret);
  return {
    id: row.id,
    url: row.url,
    secret: opts.revealSecret ? plaintext : maskSecret(plaintext),
    eventTypes: row.event_types ? (JSON.parse(row.event_types) as string[]) : null,
    createdAt: row.created_at,
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /api/scouts/:wallet/webhooks
 *
 * Register a new webhook endpoint. Generates a random HMAC signing secret,
 * returns it in plaintext exactly once. The secret is stored AES-256-GCM
 * encrypted and never returned again after this response.
 *
 * @body { url: string, eventTypes?: ContractEventType[] }
 * @response 201 { success: true, data: { id, url, secret, eventTypes, createdAt } }
 * @response 400 Invalid URL or unknown event type
 * @response 403 Wallet mismatch
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
export async function registerWebhook(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const parsed = registerWebhookSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      error: parsed.error.errors[0]?.message ?? 'Invalid request body',
    });
    return;
  }

  const { url, eventTypes } = parsed.data;
  const subscription = createWebhookSubscription(
    url,
    undefined, // auto-generate secret
    req.params.wallet as string,
    eventTypes,
  );

  logger.info({
    scout: req.params.wallet as string,
    subscriptionId: subscription.id,
    url,
    action: 'webhook_registered',
  });

  res.status(201).json({
    success: true,
    data: {
      id: subscription.id,
      url: subscription.url,
      secret: subscription.secret, // plaintext — returned only once
      eventTypes: subscription.event_types
        ? (JSON.parse(subscription.event_types) as string[])
        : null,
      createdAt: subscription.created_at,
    },
  });
}

/**
 * GET /api/scouts/:wallet/webhooks
 *
 * List all webhook subscriptions for the authenticated scout.
 * Secrets are masked — only the last 4 hex chars are visible.
 *
 * @response 200 { success: true, data: Array<{ id, url, secret (masked), eventTypes, createdAt }> }
 * @response 403 Wallet mismatch
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
export async function listWebhooks(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const rows = getWebhookSubscriptionsByScout(req.params.wallet as string);

  res.json({
    success: true,
    data: rows.map((row) => serializeSubscription(row)),
  });
}

/**
 * DELETE /api/scouts/:wallet/webhooks/:id
 *
 * Delete a webhook subscription. Scoped to the owning scout wallet — a scout
 * cannot delete another scout's subscriptions.
 *
 * @response 200 { success: true, data: { removed: true, id } }
 * @response 403 Wallet mismatch
 * @response 404 Subscription not found
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
export async function deleteWebhook(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid subscription id' });
    return;
  }

  const removed = deleteWebhookSubscription(id, req.params.wallet as string);
  if (!removed) {
    res.status(404).json({ success: false, error: 'Webhook subscription not found' });
    return;
  }

  logger.info({ scout: req.params.wallet as string, subscriptionId: id, action: 'webhook_deleted' });

  res.json({ success: true, data: { removed: true, id } });
}

/**
 * POST /api/scouts/:wallet/webhooks/:id/test
 *
 * Send a test ping to the registered webhook URL.
 * Signs the payload with the subscription's HMAC secret.
 * Returns 200 if the remote server responds with 2xx; 502 otherwise.
 *
 * @response 200 { success: true, data: { id, url, statusCode } }
 * @response 400 Invalid subscription id
 * @response 403 Wallet mismatch or subscription belongs to another scout
 * @response 404 Subscription not found
 * @response 502 Remote server returned non-2xx or connection failed
 * @auth Bearer (scout role required; wallet must match authenticated account)
 */
export async function testWebhook(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
try {
    const id = parseInt(req.params.id as string, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid subscription id' });
      return;
    }

    const row = getWebhookSubscriptionById(id);
    if (!row) {
      res.status(404).json({ success: false, error: 'Webhook subscription not found' });
      return;
    }

    // Ownership check: the subscription must belong to this scout
    if (row.scout_wallet !== req.params.wallet as string) {
      sendForbidden(res, 'Forbidden: subscription belongs to another scout');
      return;
    }

    const payload = { event: 'test', timestamp: new Date().toISOString() };
    const rawBody = JSON.stringify(payload);
    const plainSecret = decryptWebhookSecret(row.secret);
    const signature = signWebhookPayload(rawBody, plainSecret);

    try {
      const response = await fetch(row.url, {
        method: 'POST',
        body: rawBody,
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
      });

      if (!response.ok) {
        res.status(502).json({
          success: false,
          error: `Remote server responded with status ${response.status}`,
          data: { id, url: row.url, statusCode: response.status },
        });
        return;
      }

      logger.info({ scout: req.params.wallet as string, subscriptionId: id, url: row.url, action: 'webhook_test_sent' });

      res.json({
        success: true,
        data: { id, url: row.url, statusCode: response.status },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(502).json({
        success: false,
        error: `Failed to reach webhook URL: ${message}`,
        data: { id, url: row.url },
      });
    }
  } catch (err) {
    next(err);
  }
}
