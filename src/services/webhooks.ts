import fetch from 'node-fetch';
import crypto from 'crypto';
import { listWebhookSubscriptions, insertWebhookDeadLetter, insertWebhookDelivery, WebhookSubscription } from '../db';
import { logger } from '../utils/logger';
import { recordWebhookDelivery, incrementWebhookDeadLettersTotal, incrementWebhookCircuitOpenTotal } from '../middleware/metrics';
import { context, propagation, trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';
import { getCorrelationId } from '../utils/requestContext';
import { getVersionInfo } from '../version';
import { CircuitBreakerOpenError } from '../utils/circuitBreaker';
import {
  CIRCUIT_OPEN_REASON,
  getWebhookBreaker,
  isSuspended,
  recordDeliveryFailure,
  recordDeliverySuccess,
} from './webhookHealth';

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
  /** Event type sent as the `X-Webhook-Event` header. */
  eventType?: string;
  /** Stable delivery id sent as the `X-Webhook-Delivery` header. */
  deliveryId?: string;
  /** Subscription whose current and previous secrets sign the delivery. */
  subscription?: WebhookSubscription;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a versioned, multi-value signature header for webhook deliveries.
 *
 * Format: `t=<timestamp>,v1=<signature-current>,v1=<signature-previous>`
 *
 * This allows subscribers to verify against multiple secrets during rotation
 * (current + previous), supporting zero-downtime secret rotation.
 *
 * The legacy single `X-Webhook-Signature: sha256=<digest>` header is still
 * sent when `WEBHOOK_LEGACY_SIGNATURE=true` (default: true during deprecation
 * period) so existing receivers continue to work.
 *
 * @param rawBody - The exact JSON string that will be sent as the request body
 * @param currentSecret - The current HMAC secret
 * @param timestamp - Unix timestamp in seconds
 * @param previousSecret - Optional previous secret during rotation window
 * @param previousSecretExpiresAt - Optional expiry timestamp (epoch ms) for previous secret
 * @returns Object with `versioned` (new header value) and `legacy` (old header value) properties
 */
export function buildSignatureHeader(
  rawBody: string,
  currentSecret: string,
  timestamp: string,
  previousSecret?: string | null,
  previousSecretExpiresAt?: number | null,
): { versioned: string; legacy: string | null } {
  // Compute current signature (always)
  const currentSig = computeHmac(rawBody, currentSecret, timestamp);

  // Compute previous signature if rotation is active
  const previousSig = previousSecret
    ? computeHmac(rawBody, previousSecret, timestamp)
    : null;

  // Build versioned header
  let versioned = `t=${timestamp},v1=${currentSig}`;
  if (previousSig) {
    // Check if previous secret is still valid
    const isExpired = previousSecretExpiresAt
      ? Date.now() > previousSecretExpiresAt
      : false;
    if (!isExpired) {
      versioned += `,v1=${previousSig}`;
    }
  }

  // Build legacy header for backward compatibility
  const legacy = config.webhook?.enableLegacySignature !== false
    ? `sha256=${currentSig}`
    : null;

  return { versioned, legacy };
}

/**
 * Computes HMAC-SHA256 signature for webhook payload.
 *
 * @param rawBody - The exact JSON string that will be sent as the request body
 * @param secret - The HMAC secret
 * @param timestamp - Unix timestamp in seconds
 * @returns Hex-encoded HMAC digest
 */
function computeHmac(rawBody: string, secret: string, timestamp: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
}

/**
 * Computes the `X-Webhook-Signature` header value for a raw request body.
 *
 * Format: `sha256=<hex-encoded HMAC-SHA256 digest>`, computed over
 * `<timestamp>.<raw body>` using the subscriber's secret as the HMAC key.
 * The timestamp is Unix time in seconds and is sent separately in the
 * `X-Webhook-Timestamp` header.
 *
 * @deprecated Use buildSignatureHeader() instead. This function will be
 * removed once the versioned signature migration is complete.
 */
export function signWebhookPayload(rawBody: string, secret: string, timestamp: string): string {
  return `sha256=${computeHmac(rawBody, secret, timestamp)}`;
}

function parseRetryAfter(response: Awaited<ReturnType<typeof fetch>>): number | null {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter === null) return null;

  const value = retryAfter.trim();
  if (/^\d+$/.test(value)) {
    return Math.min(Number(value) * 1000, 2_147_483_647);
  }

  const retryAt = Date.parse(value);
  return Number.isNaN(retryAt)
    ? null
    : Math.min(Math.max(0, retryAt - Date.now()), 2_147_483_647);
}

/**
 * Executes a webhook POST with retry logic.
 * Uses full-jitter exponential backoff between attempts to avoid synchronized retries.
 * When `options.secret` is provided, signs the raw request body and attaches it as
 * the `X-Webhook-Signature` header. Always attaches a descriptive `User-Agent`
 * plus `X-Webhook-Event`/`X-Webhook-Delivery` headers when the corresponding
 * options are provided, so receivers can route and deduplicate without parsing
 * the body.
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
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': `ScoutOff-Webhooks/${getVersionInfo().version}`,
    };
    if (options.eventType) {
      headers['X-Webhook-Event'] = options.eventType;
    }
    if (options.deliveryId) {
      headers['X-Webhook-Delivery'] = options.deliveryId;
    }

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      span.setAttribute('webhook.attempt', attempt);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let retryAfterMs: number | null = null;
      try {
        const requestHeaders = { ...headers };
        propagation.inject(trace.setSpan(context.active(), span), requestHeaders);
        if (options.secret) {
          const timestamp = String(Math.floor(Date.now() / 1000));
          requestHeaders['X-Webhook-Timestamp'] = timestamp;
          // Use subscription's secret and any active previous_secret during rotation
          const subscription = options.subscription;
          const { versioned, legacy } = buildSignatureHeader(
            rawBody,
            options.secret,
            timestamp,
            subscription?.previous_secret ?? null,
            subscription?.previous_secret_expires_at ? Number(subscription.previous_secret_expires_at) : null,
          );
          requestHeaders['X-Webhook-Signature'] = legacy ?? '';
          requestHeaders['X-Webhook-Signature-V1'] = versioned;
        }
        const response = await fetch(url, {
          method: 'POST',
          body: rawBody,
          headers: requestHeaders,
          signal: controller.signal,
        });

        if (!response.ok) {
          span.setAttribute('webhook.status', response.status);
          if (response.status === 429 || response.status === 503) {
            retryAfterMs = parseRetryAfter(response);
          }
          response.body?.resume();
          throw new Error(`Webhook dispatch failed with status ${response.status}`);
        }
        span.setAttribute('webhook.status', response.status);
        response.body?.resume();
        return;
      } catch (err) {
        lastError = controller.signal.aborted
          ? new Error(`Webhook dispatch timed out after ${timeoutMs}ms`)
          : err;
      } finally {
        clearTimeout(timer);
      }

      if (attempt < retries) {
        const backoffCapMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
        const delayMs =
          retryAfterMs ?? Math.floor(Math.random() * (backoffCapMs + 1));
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
  // Suspended subscriptions receive no deliveries (#1512).
  const subscriptions = listWebhookSubscriptions().filter((s) => !isSuspended(s));
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
    await getWebhookBreaker(subscription.id).execute(() =>
      postWebhookWithRetry(subscription.url, body, {
        ...RETRY_OPTIONS,
        secret: subscription.secret,
        subscription,
        eventType,
        deliveryId,
      }),
    );
    recordDeliverySuccess(subscription);
    recordWebhookDelivery('success');
    recordDeliveryHistory(subscription, eventType, deliveryId, {
      status: 'success',
      latencyMs: Date.now() - startedAt,
    });
  } catch (err) {
    // Open circuit: no HTTP call was made, so dead-letter immediately without
    // burning retries or counting another failure against the endpoint (#1512).
    const circuitOpen = err instanceof CircuitBreakerOpenError;
    const failureReason = circuitOpen ? CIRCUIT_OPEN_REASON : err instanceof Error ? err.message : String(err);
    if (circuitOpen) incrementWebhookCircuitOpenTotal();
    else await recordDeliveryFailure(subscription);
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
      attempts: circuitOpen ? 0 : RETRY_OPTIONS.retries,
    });
    incrementWebhookDeadLettersTotal();
    recordWebhookDelivery('dead_letter');
    recordDeliveryHistory(subscription, eventType, deliveryId, {
      status: 'failure',
      errorMessage: failureReason,
      attemptCount: circuitOpen ? 0 : RETRY_OPTIONS.retries,
      latencyMs: Date.now() - startedAt,
    });
  }
}
