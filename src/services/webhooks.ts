import fetch from 'node-fetch';
import crypto from 'crypto';
import { listWebhookSubscriptions, insertWebhookDeadLetter, insertWebhookDelivery, WebhookSubscription } from '../db';
import { logger } from '../utils/logger';
import { recordWebhookDelivery, incrementWebhookDeadLettersTotal } from '../middleware/metrics';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';
import { getCorrelationId } from '../utils/requestContext';

/**
 * Generate a unique, stable delivery identifier for a webhook event.
 * The ID is a UUID v4, generated once per logical delivery (first dispatch)
 * and carried through to every dead-letter replay so subscribers can
 * deduplicate.  The ID is included in the signed payload body, so swapping
 * it invalidates the HMAC.
 */
export function generateDeliveryId(): string {
  return crypto.randomUUID();
}

const tracer = trace.getTracer('scout-off-backend');

type WebhookRetryOptions = {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** When provided, the raw JSON body is signed with HMAC-SHA256 using this secret. */
  secret?: string;
  /**
   * Per-attempt timeout in ms. An attempt that hasn't completed within this
   * window is aborted and treated as a failed attempt (proceeding to
   * retry/backoff or dead-lettering per the existing logic) instead of
   * hanging indefinitely on an unresponsive subscriber. Defaults to
   * config.webhook.timeoutMs.
   */
  timeoutMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Generate a simple unique delivery ID (timestamp + random hex). */
function newDeliveryId(): string {
  return `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Computes the `X-Webhook-Signature` header value for a raw request body.
 *
 * Format: `sha256=<hex-encoded HMAC-SHA256 digest>`, computed over the exact
 * raw bytes sent on the wire (not a re-serialized object) using the
 * subscriber's secret as the HMAC key. See docs/webhooks.md for the
 * receiver-side verification procedure.
 */
export function signWebhookPayload(rawBody: string, secret: string): string {
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return `sha256=${digest}`;
}

/**
 * Executes a webhook POST with retry logic.
 * Uses exponential backoff between attempts to reduce pressure on transient failures.
 * When `options.secret` is provided, signs the raw request body and attaches it as
 * the `X-Webhook-Signature` header.
 */
export async function postWebhookWithRetry(
  url: string,
  payload: unknown,
  options: WebhookRetryOptions = {}
): Promise<void> {
  const span = tracer.startSpan('webhooks.postWithRetry', { attributes: { 'webhook.url': url } });
  try {
    const retries = options.retries ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 500;
    const maxDelayMs = options.maxDelayMs ?? 5000;
    const timeoutMs = options.timeoutMs ?? config.webhook.timeoutMs;
    let lastError: unknown;

    // Serialize once so the signature is computed over the exact bytes sent.
    const rawBody = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (options.secret) {
      headers['X-Webhook-Signature'] = signWebhookPayload(rawBody, options.secret);
    }

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      span.setAttribute('webhook.attempt', attempt);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          body: rawBody,
          headers,
          signal: controller.signal,
        });

        if (!response.ok) {
          span.setAttribute('webhook.status', response.status);
          throw new Error(`Webhook dispatch failed with status ${response.status}`);
        }
        span.setAttribute('webhook.status', response.status);
        return;
      } catch (err) {
        lastError = controller.signal.aborted
          ? new Error(`Webhook dispatch timed out after ${timeoutMs}ms`)
          : err;
      } finally {
        clearTimeout(timer);
      }

      if (attempt < retries) {
        const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        await sleep(delayMs);
      }
    }

    throw lastError;
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    throw err;
  } finally {
    span.end();
  }
}

const RETRY_OPTIONS = { retries: 3, baseDelayMs: 500, maxDelayMs: 5000 };

/**
 * Dispatches an event to every registered webhook subscriber, signing each
 * delivery with that subscriber's own secret. If a delivery exhausts its
 * retries, it is persisted to the dead-letter queue (webhook_dead_letters)
 * instead of being dropped — this function itself never rejects on a
 * delivery failure so a slow/broken subscriber can't break the caller.
 */
export async function dispatchEventWebhook(eventType: string, payload: unknown): Promise<void> {
  const subscriptions = listWebhookSubscriptions();
  if (subscriptions.length === 0) return;

  // Generate a stable delivery ID once for this logical event.
  // All subscribers receive the same ID for the same event, but dead-letter
  // replays reuse the ID from the original delivery (stored in the payload).
  const deliveryId = generateDeliveryId();
  const correlationId = getCorrelationId();
  const body = {
    deliveryId,
    eventType,
    payload,
    ...(correlationId ? { correlationId } : {}),
  };

  await Promise.all(
    subscriptions.map((subscription: WebhookSubscription) =>
      deliverToSubscription(subscription, eventType, body, deliveryId)
    )
  );
}

/**
 * Persist a webhook delivery-history row (#1121). Best-effort: a DB failure here
 * must never affect the delivery outcome or the dead-letter path.
 */
function recordDeliveryHistory(
  subscription: WebhookSubscription,
  eventType: string,
  deliveryId: string,
  outcome: {
    status: 'success' | 'failure';
    errorMessage?: string;
    attemptCount?: number;
    latencyMs?: number;
  },
): void {
  try {
    insertWebhookDelivery({
      subscriptionId: String(subscription.id),
      eventType,
      deliveryId,
      attemptCount: outcome.attemptCount ?? 1,
      status: outcome.status,
      errorMessage: outcome.errorMessage ?? null,
      latencyMs: outcome.latencyMs ?? null,
    });
  } catch (dbErr) {
    logger.warn(
      `[webhooks] failed to persist delivery-history row — subscriptionId=${subscription.id} delivery_id=${deliveryId} err=${
        dbErr instanceof Error ? dbErr.message : String(dbErr)
      }`,
    );
  }
}

async function deliverToSubscription(
  subscription: WebhookSubscription,
  eventType: string,
  body: unknown,
  deliveryId: string,
): Promise<void> {
  const startedAt = Date.now();
  try {
    await postWebhookWithRetry(subscription.url, body, {
      ...RETRY_OPTIONS,
      secret: subscription.secret,
    });
    recordWebhookDelivery('success');
    recordDeliveryHistory(subscription, eventType, deliveryId, {
      status: 'success',
      latencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    const failureReason = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[webhooks] delivery exhausted retries — subscriptionId=${subscription.id} url=${subscription.url} eventType=${eventType} reason=${failureReason} delivery_id=${deliveryId}`
    );
    insertWebhookDeadLetter({
      subscriptionId: subscription.id,
      url: subscription.url,
      eventType,
      payload: JSON.stringify(body),
      deliveryId,
      failureReason,
      attempts: RETRY_OPTIONS.retries,
    });
    incrementWebhookDeadLettersTotal();
    recordWebhookDelivery('dead_letter');
    recordDeliveryHistory(subscription, eventType, deliveryId, {
      status: 'failure',
      errorMessage: failureReason,
      attemptCount: RETRY_OPTIONS.retries,
      latencyMs: Date.now() - startedAt,
    });
  }
}
