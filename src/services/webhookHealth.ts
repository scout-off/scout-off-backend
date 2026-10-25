/**
 * Webhook endpoint health (#1512): per-subscription circuit breakers,
 * consecutive-failure tracking, automatic suspension and reactivation.
 */
import {
  WebhookSubscription,
  countWebhookSubscriptionsByStatus,
  reactivateWebhookSubscription,
  recordWebhookSubscriptionFailure,
  recordWebhookSubscriptionSuccess,
  listWebhookSubscriptions,
} from '../db';
import config from '../config';
import { CircuitBreaker } from '../utils/circuitBreaker';
import { logger } from '../utils/logger';
import { logAuditEvent } from './audit';
import { setWebhookSubscriptionStatusCounts } from '../middleware/metrics';
import { postWebhookWithRetry } from './webhooks';

/** Reason recorded on dead letters created while a subscription's circuit is open. */
export const CIRCUIT_OPEN_REASON = 'circuit_open';

/** The span rule only applies once a streak is at least this long (avoids suspending on two stray failures). */
const MIN_FAILURES_FOR_SPAN_RULE = 5;

const breakers = new Map<number, CircuitBreaker>();

/** Circuit breaker for one subscription, created on first use. */
export function getWebhookBreaker(subscriptionId: number): CircuitBreaker {
  let breaker = breakers.get(subscriptionId);
  if (!breaker) {
    breaker = new CircuitBreaker({
      ...config.circuitBreaker.webhook,
      name: `webhook-subscription-${subscriptionId}`,
    });
    breakers.set(subscriptionId, breaker);
  }
  return breaker;
}

export function resetWebhookBreakers(): void {
  breakers.clear();
}

export function refreshSubscriptionStatusGauge(): void {
  try {
    setWebhookSubscriptionStatusCounts(countWebhookSubscriptionsByStatus());
  } catch (err) {
    logger.warn(`[webhooks] failed to refresh subscription status gauge: ${(err as Error).message}`);
  }
}

export function isSuspended(subscription: Pick<WebhookSubscription, 'status'>): boolean {
  return subscription.status === 'suspended';
}

export function recordDeliverySuccess(subscription: WebhookSubscription): void {
  try {
    recordWebhookSubscriptionSuccess(subscription.id);
    if ((subscription.consecutive_failures ?? 0) > 0 || subscription.status === 'degraded') {
      refreshSubscriptionStatusGauge();
    }
  } catch (err) {
    logger.warn(`[webhooks] failed to record delivery success: ${(err as Error).message}`);
  }
}

/** Record an exhausted delivery; suspends the subscription when thresholds are crossed. */
export async function recordDeliveryFailure(subscription: WebhookSubscription): Promise<void> {
  try {
    const result = recordWebhookSubscriptionFailure(subscription.id, {
      maxFailures: config.webhook.suspendAfterFailures,
      maxSpanMs: config.webhook.suspendAfterMs,
      minFailuresForSpan: MIN_FAILURES_FOR_SPAN_RULE,
    });
    if (!result) return;
    if (!result.justSuspended) {
      if (result.row.consecutive_failures === 1) refreshSubscriptionStatusGauge();
      return;
    }
    refreshSubscriptionStatusGauge();
    logger.warn(
      `[webhooks] subscription suspended — subscriptionId=${subscription.id} reason=${result.row.suspended_reason}`,
    );
    await logAuditEvent({
      action: 'webhook_subscription_suspended',
      timestamp: new Date().toISOString(),
      adminWallet: subscription.scout_wallet ?? undefined,
      queryParams: {
        subscription_id: subscription.id,
        url: subscription.url,
        reason: result.row.suspended_reason,
      },
    }).catch(() => {});
    await notifySuspension(result.row);
  } catch (err) {
    logger.warn(`[webhooks] failed to record delivery failure: ${(err as Error).message}`);
  }
}

/** Best-effort `webhook.suspended` notice to another healthy subscription of the same scout. */
async function notifySuspension(suspended: WebhookSubscription): Promise<void> {
  if (!suspended.scout_wallet) return;
  const healthy = listWebhookSubscriptions().find(
    (s) =>
      s.id !== suspended.id &&
      s.scout_wallet === suspended.scout_wallet &&
      s.status !== 'suspended' &&
      !getWebhookBreaker(s.id).isOpen(),
  );
  if (!healthy) return;
  try {
    await postWebhookWithRetry(
      healthy.url,
      {
        eventType: 'webhook.suspended',
        payload: {
          subscriptionId: suspended.id,
          url: suspended.url,
          reason: suspended.suspended_reason,
          suspendedAt: suspended.suspended_at,
        },
      },
      { retries: 1, secret: healthy.secret, subscription: healthy, eventType: 'webhook.suspended' },
    );
  } catch (err) {
    logger.warn(`[webhooks] webhook.suspended notice to subscription ${healthy.id} failed: ${(err as Error).message}`);
  }
}

export type ReactivateResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Reactivate a subscription, but only if a test ping to its endpoint succeeds.
 * `subscription.secret` must be the decrypted signing secret.
 */
export async function reactivateAfterPing(
  subscription: WebhookSubscription,
  actor: string,
): Promise<ReactivateResult> {
  try {
    await postWebhookWithRetry(
      subscription.url,
      { event: 'test', timestamp: new Date().toISOString() },
      { retries: 1, secret: subscription.secret, subscription, eventType: 'webhook.reactivation_ping' },
    );
  } catch (err) {
    return { ok: false, error: `Test ping failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  reactivateWebhookSubscription(subscription.id);
  getWebhookBreaker(subscription.id).reset();
  refreshSubscriptionStatusGauge();
  await logAuditEvent({
    action: 'webhook_subscription_reactivated',
    timestamp: new Date().toISOString(),
    adminWallet: actor,
    queryParams: { subscription_id: subscription.id, url: subscription.url },
  }).catch(() => {});
  return { ok: true };
}
