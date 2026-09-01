/**
 * Dead-letter queue depth / insert-rate alerting (#1131).
 *
 * Exports a per-subscription gauge (`scout_off_webhook_dead_letters_total`) and
 * evaluates configurable size + rate thresholds during the retry job sweep.
 */

import { logger } from '../utils/logger';
import {
  setWebhookDeadLetterGauge,
  getWebhookDeadLetterInsertTimestamps,
} from '../middleware/metrics';
import config from '../config';

export interface DeadLetterSubscriptionCount {
  subscription_id: number | null;
  count: number;
}

export interface DeadLetterAlertResult {
  total: number;
  bySubscription: DeadLetterSubscriptionCount[];
  sizeExceeded: boolean;
  rateExceeded: boolean;
  insertsInWindow: number;
  notified: boolean;
}

/**
 * Refresh the Prometheus gauge from current DB counts and evaluate thresholds.
 * Emits a critical log (and optional platform-admin webhook) when size or
 * insert-rate crosses the configured limits.
 */
export async function evaluateDeadLetterAlerts(
  total: number,
  bySubscription: DeadLetterSubscriptionCount[],
  options: {
    notify?: (payload: Record<string, unknown>) => Promise<void>;
    now?: number;
  } = {},
): Promise<DeadLetterAlertResult> {
  const now = options.now ?? Date.now();
  const { sizeThreshold, rateThreshold, rateWindowMs, adminNotifyUrl } =
    config.webhookDeadLetterAlert;

  // Refresh gauge — one series per subscription plus an "unknown" bucket.
  const gaugeEntries: Array<{ subscriptionId: string; count: number }> = bySubscription.map(
    (row) => ({
      subscriptionId: row.subscription_id == null ? 'none' : String(row.subscription_id),
      count: row.count,
    }),
  );
  if (gaugeEntries.length === 0 && total === 0) {
    setWebhookDeadLetterGauge([]);
  } else {
    setWebhookDeadLetterGauge(gaugeEntries);
  }

  const windowStart = now - rateWindowMs;
  const insertsInWindow = getWebhookDeadLetterInsertTimestamps().filter((t) => t >= windowStart)
    .length;

  const sizeExceeded = total > sizeThreshold;
  const rateExceeded = insertsInWindow > rateThreshold;

  let notified = false;

  if (sizeExceeded || rateExceeded) {
    const topCulprits = [...bySubscription]
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((r) => `sub=${r.subscription_id ?? 'none'}:${r.count}`)
      .join(', ');

    const level = sizeExceeded && total > sizeThreshold * 2 ? 'critical' : 'critical';
    const message =
      `[webhooks] webhook_dead_letter_threshold_crossed — ` +
      `total=${total} sizeThreshold=${sizeThreshold} ` +
      `insertsInWindow=${insertsInWindow} rateThreshold=${rateThreshold} ` +
      `windowMs=${rateWindowMs} culprits=[${topCulprits}]`;

    if (level === 'critical') {
      logger.critical(message);
    } else {
      logger.warn(message);
    }

    // Optional platform-admin notification channel.
    const notifyUrl = adminNotifyUrl;
    if (notifyUrl || options.notify) {
      const payload = {
        alert: 'webhook_dead_letter_threshold_crossed',
        total,
        sizeThreshold,
        insertsInWindow,
        rateThreshold,
        rateWindowMs,
        bySubscription,
        at: new Date(now).toISOString(),
      };
      try {
        if (options.notify) {
          await options.notify(payload);
        } else if (notifyUrl) {
          const fetch = (await import('node-fetch')).default;
          await fetch(notifyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
        }
        notified = true;
      } catch (err) {
        logger.warn(
          `[webhooks] dead-letter admin notify failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return {
    total,
    bySubscription,
    sizeExceeded,
    rateExceeded,
    insertsInWindow,
    notified,
  };
}
