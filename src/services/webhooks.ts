import axios from 'axios';
import config from '../config';

type WebhookRetryOptions = {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes a webhook POST with retry logic.
 * Uses exponential backoff between attempts to reduce pressure on transient failures.
 */
export async function postWebhookWithRetry(
  url: string,
  payload: unknown,
  options: WebhookRetryOptions = {}
): Promise<void> {
  const retries = options.retries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 5000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await axios.post(url, payload, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.status >= 200 && response.status < 300) {
        return;
      }

      lastError = new Error(`Webhook dispatch failed with status ${response.status}`);
    } catch (err) {
      lastError = err;
    }

    if (attempt < retries) {
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export async function dispatchEventWebhook(eventType: string, payload: unknown): Promise<void> {
  if (!config.webhook.enabled || !config.webhook.url) {
    return;
  }
  await postWebhookWithRetry(
    config.webhook.url,
    { eventType, payload },
    {
      retries: 3,
      baseDelayMs: 500,
      maxDelayMs: 5000,
    }
  );
}
