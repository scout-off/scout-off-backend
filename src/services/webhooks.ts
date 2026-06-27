import fetch from 'node-fetch';
import config from '../config';
import { logger } from '../utils/logger';

export type WebhookRetryOptions = {
  /** Total number of attempts (default: 3). */
  retries?: number;
  /**
   * Base delay in ms for exponential backoff.
   * Delays are: 0 (immediate), baseDelayMs, baseDelayMs * 4, …
   * Default: 1000 ms, producing the spec schedule: 0 ms, 1 s, 4 s.
   */
  baseDelayMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculates the delay before attempt `attempt` (0-indexed).
 *   attempt 0 → 0 ms  (immediate)
 *   attempt 1 → baseDelayMs
 *   attempt 2 → baseDelayMs * 4
 *   attempt n → baseDelayMs * 4^(n-1)
 */
function retryDelay(attempt: number, baseDelayMs: number): number {
  if (attempt === 0) return 0;
  return baseDelayMs * Math.pow(4, attempt - 1);
}

/**
 * Executes a webhook POST with an in-process retry queue and exponential backoff.
 *
 * Schedule (default baseDelayMs=1000):
 *   attempt 1 — immediate
 *   attempt 2 — after 1 s
 *   attempt 3 — after 4 s
 *
 * Throws the last error if all attempts are exhausted, so callers can decide
 * whether to log at the appropriate level.
 */
export async function postWebhookWithRetry(
  url: string,
  payload: unknown,
  options: WebhookRetryOptions = {},
): Promise<void> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  let lastError: unknown;

  for (let attempt = 0; attempt < retries; attempt += 1) {
    const delay = retryDelay(attempt, baseDelayMs);
    if (delay > 0) {
      await sleep(delay);
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`Webhook dispatch failed with status ${response.status}`);
      }

      // Log at info level when delivery succeeds on a retry (not the first attempt).
      if (attempt > 0) {
        logger.info(
          `[webhooks] delivery succeeded on attempt ${attempt + 1} url=${url}`,
        );
      }
      return;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError;
}

/**
 * Fire-and-forget wrapper used by controllers.
 *
 * Enqueues the webhook dispatch with the configured retry schedule.
 * Errors are caught and logged as warnings after all retries are exhausted —
 * they are never re-thrown so a webhook failure never crashes an HTTP response.
 */
export function dispatchEventWebhook(
  eventType: string,
  payload: unknown,
): void {
  if (!config.webhook.enabled || !config.webhook.url) {
    return;
  }

  const url = config.webhook.url;

  // Run asynchronously — do not await so the caller is never blocked.
  postWebhookWithRetry(
    url,
    { eventType, payload },
    {
      retries: 3,
      baseDelayMs: 1000, // schedule: 0 ms → 1 s → 4 s
    },
  ).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[webhooks] all retries exhausted — eventType=${eventType} url=${url} error=${message}`,
    );
  });
}
