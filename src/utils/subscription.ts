import { queryEvents } from '../db';
import { isSubscribed } from '../services/stellar';
import { SubscriptionTier } from '../types';

export interface ActiveSubscription {
  active: boolean;
  tier: SubscriptionTier | null;
  expiresAt: number | null;
}

/**
 * Resolves the current subscription state for a scout wallet using a two-step
 * fallback strategy:
 *
 * 1. Query the on-chain stub (`isSubscribed`). If the chain reports an active
 *    subscription, return it immediately.
 * 2. Fall back to indexed `scout_subscribed` events and check the most recent
 *    one against the current wall-clock time.
 *
 * Returns `{ active: false, tier: null, expiresAt: null }` when neither source
 * indicates an active subscription.
 */
export async function getActiveSubscription(scoutWallet: string): Promise<ActiveSubscription> {
  // Step 1 — on-chain check
  const onChain = await isSubscribed(scoutWallet);
  if (onChain.active) {
    return {
      active: true,
      // On-chain stub returns expiresAt as a string; coerce to a number if
      // present so callers always receive a consistent type.
      tier: 'basic',
      expiresAt: onChain.expiresAt != null ? Number(onChain.expiresAt) : null,
    };
  }

  // Step 2 — indexed events fallback
  const subs = queryEvents('scout_subscribed').filter((e) => e.payload.scout === scoutWallet);
  const latest = subs.at(-1);
  if (!latest) {
    return { active: false, tier: null, expiresAt: null };
  }

  const expiresAt = latest.payload.subscription_expiry as number;
  const now = Math.floor(Date.now() / 1000);
  const active = expiresAt > now;
  const tier = ((latest.payload.tier as string | undefined) ?? 'basic') as SubscriptionTier;

  return { active, tier: active ? tier : null, expiresAt };
}

/** Default grace period in hours after subscription expiry before access is revoked. */
export const SUBSCRIPTION_GRACE_PERIOD_HOURS = 24;

/**
 * Determines if a subscription is still considered active, accounting for a
 * grace period after the nominal expiry timestamp.
 *
 * @param expiresAt - Unix-second expiry timestamp, or null for no subscription.
 * @param gracePeriodHours - Hours of grace period after expiry (default: SUBSCRIPTION_GRACE_PERIOD_HOURS).
 * @returns true if the subscription is active or within the grace period.
 */
export function isActive(
  expiresAt: number | null,
  gracePeriodHours: number = SUBSCRIPTION_GRACE_PERIOD_HOURS,
): boolean {
  if (expiresAt === null) return false;
  const now = Math.floor(Date.now() / 1000);
  return now <= expiresAt + gracePeriodHours * 3600;
}