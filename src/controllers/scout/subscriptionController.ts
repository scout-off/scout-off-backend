import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  queryEvents,
  getLatestSubscription,
  insertSubscription,
  dbRenewSubscription,
  dbCancelSubscription,
} from '../../db';
import {
  isSubscribed,
  purchaseSubscription,
  PaymentError,
  SubscriptionError,
  renewSubscription as stellarRenewSubscription,
  cancelSubscriptionOnChain,
} from '../../services/stellar';
import { logger } from '../../utils/logger';
import { checkWalletOwnership } from '../../middleware/requireOwner';
import { broadcaster } from '../../services/eventBroadcaster';
import { paymentErrorStatus, gracePeriodSeconds } from './helpers';

// ─── Validation schemas ────────────────────────────────────────────────────────

export const subscribeSchema = z
  .object({
    tier: z.enum(['basic', 'premium']),
    duration: z.number().int().min(1).max(365),
  })
  .strict();

// ─── GET /api/scouts/:wallet/subscription ─────────────────────────────────────

/** GET /api/scouts/:wallet/subscription */
export async function getSubscription(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  const { wallet } = req.params as { wallet: string };

  const now = Math.floor(Date.now() / 1000);
  const graceSeconds = gracePeriodSeconds();

  // On-chain verification stub — falls back to local DB / indexed events when stub returns inactive
  const onChain = await isSubscribed(wallet);
  if (onChain.active) {
    res.json({
      success: true,
      data: {
        active: true,
        tier: 'basic',
        expiresAt: onChain.expiresAt,
        remainingDays: null,
        gracePeriodActive: false,
      },
    });
    return;
  }

  // Check local subscriptions table first
  const localSub = await getLatestSubscription(wallet);
  if (localSub) {
    const active = localSub.expires_at > now;
    const gracePeriodActive = !active && localSub.expires_at > now - graceSeconds;
    const remainingDays = active ? Math.ceil((localSub.expires_at - now) / 86400) : 0;
    res.json({
      success: true,
      data: {
        active: active || gracePeriodActive,
        tier: localSub.tier,
        expiresAt: localSub.expires_at,
        remainingDays,
        gracePeriodActive,
      },
    });
    return;
  }

  // Fall back to indexed events
  const subs = queryEvents('scout_subscribed', { payloadFilter: { scout: wallet } });
  const latest = subs.at(-1);
  if (!latest) {
    res.json({
      success: true,
      data: {
        active: false,
        tier: null,
        expiresAt: null,
        remainingDays: 0,
        gracePeriodActive: false,
      },
    });
    return;
  }
  const expiresAt = latest.payload.subscription_expiry as number;
  const active = expiresAt > now;
  const gracePeriodActive = !active && expiresAt > now - graceSeconds;
  const remainingDays = active ? Math.ceil((expiresAt - now) / 86400) : 0;
  res.json({
    success: true,
    data: {
      active: active || gracePeriodActive,
      tier: (latest.payload.tier as string) ?? 'basic',
      expiresAt,
      remainingDays,
      gracePeriodActive,
    },
  });
}

// ─── POST /api/scouts/:wallet/subscribe ───────────────────────────────────────

/** POST /api/scouts/:wallet/subscribe — new subscription */
export async function subscribe(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { wallet } = req.params as { wallet: string };
    // Ownership is enforced by requireWalletOwner() at the route level; the
    // shared guard is re-invoked here so direct callers (unit tests) get the
    // same protection without duplicating the comparison inline.
    // validateAddress: false preserves the historical behavior of this
    // endpoint, which never validated the address format.
    if (!checkWalletOwnership(req, res, { validateAddress: false })) return;

    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
      return;
    }
    const { tier, duration } = parsed.data;

    const result = await purchaseSubscription(wallet, tier, duration);

    // Persist locally — grace period is applied at query time, not stored
    await insertSubscription({
      scout_wallet: wallet,
      tier,
      expires_at: result.expiresAt,
      created_at: Math.floor(Date.now() / 1000),
    });

    logger.info(
      `[scout] action=new_subscription scout=${wallet} tier=${tier} duration=${duration} expiry=${result.expiresAt}`,
    );

    // Broadcast SSE event to any connected subscribers
    broadcaster.broadcast({
      type: 'scout_subscribed',
      payload: {
        scout: wallet,
        tier,
        expires_at: result.expiresAt,
        tx_hash: result.transactionId,
        timestamp: new Date().toISOString(),
      },
    });

    const body = {
      success: true,
      data: {
        transactionId: result.transactionId,
        tier,
        expiresAt: result.expiresAt,
        status: result.status,
      },
    };
    res.status(201).json(body);
  } catch (err) {
    if (err instanceof PaymentError) {
      const body = { success: false, error: err.message, code: err.code };
      res.status(402).json(body);
      return;
    }
    next(err);
  }
}

// ─── PUT /api/scouts/:wallet/subscribe ────────────────────────────────────────

/**
 * PUT /api/scouts/:wallet/subscribe — renew or create subscription.
 * If an active (or grace-period) subscription exists, extends its expiry.
 * If none exists, behaves like POST (creates new).
 * Returns 200 for renewal, 201 for new subscription.
 */
export async function renewSubscription(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { wallet } = req.params as { wallet: string };
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
      return;
    }
    const { tier, duration } = parsed.data;

    const existingSub = await getLatestSubscription(wallet);

    if (existingSub) {
      // Renewal path — extend existing subscription
      const result = await stellarRenewSubscription(wallet, tier, duration, existingSub.expires_at);

      await dbRenewSubscription({
        id: existingSub.id,
        tier,
        expires_at: result.expiresAt,
      });

      logger.info(
        `[scout] action=renew_subscription scout=${wallet} tier=${tier} duration=${duration} newExpiry=${result.expiresAt}`,
      );
      res.status(200).json({ success: true, data: result });
    } else {
      // No subscription exists — create a new one (same as POST)
      const result = await purchaseSubscription(wallet, tier, duration);

      await insertSubscription({
        scout_wallet: wallet,
        tier,
        expires_at: result.expiresAt,
        created_at: Math.floor(Date.now() / 1000),
      });

      logger.info(
        `[scout] action=new_subscription_via_put scout=${wallet} tier=${tier} duration=${duration} expiry=${result.expiresAt}`,
      );
      res.status(201).json({ success: true, data: result });
    }
  } catch (err) {
    if (err instanceof PaymentError) {
      res
        .status(paymentErrorStatus(err.code))
        .json({ success: false, error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}

// ─── DELETE /api/scouts/:wallet/subscribe ─────────────────────────────────────

/**
 * DELETE /api/scouts/:wallet/subscribe — cancel an active subscription.
 * Returns 404 if no active subscription exists locally or on-chain.
 * Returns 403 if the contract rejects the caller as unauthorized.
 * Records cancellation on-chain first; DB row is only updated after confirmation.
 */
export async function cancelSubscription(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { wallet } = req.params as { wallet: string };

    const existingSub = await getLatestSubscription(wallet);
    if (!existingSub) {
      res.status(404).json({ success: false, error: 'No active subscription found' });
      return;
    }

    // Submit on-chain first — DB is only updated after this succeeds.
    // SubscriptionError (NOT_SUBSCRIBED / UNAUTHORIZED) maps to 4xx.
    // PaymentError maps to 402. Unexpected errors bubble to the 500 handler.
    const onChainResult = await cancelSubscriptionOnChain(wallet);

    const now = Math.floor(Date.now() / 1000);
    await dbCancelSubscription({ id: existingSub.id, cancelled_at: now });

    logger.info(
      `[scout] action=cancel_subscription scout=${wallet} subId=${existingSub.id} txId=${onChainResult.transactionId}`,
    );

    res.status(200).json({
      success: true,
      data: {
        transactionId: onChainResult.transactionId,
        cancelledAt: now,
        wallet,
      },
    });
  } catch (err) {
    if (err instanceof SubscriptionError) {
      const status = err.code === 'UNAUTHORIZED' ? 403 : 404;
      res.status(status).json({ success: false, error: err.message, code: err.code });
      return;
    }
    if (err instanceof PaymentError) {
      res.status(402).json({ success: false, error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}
