import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  queryEvents,
  getPlayerById,
  getLatestSubscription,
  getSubscriptionsByScout,
  insertSubscription,
  dbRenewSubscription,
  dbCancelSubscription,
  insertContactUnlock,
  getContactUnlocksByScout,
  hasContactUnlock,
  updatePlayerProgress,
  insertTrialOffer as insertTrialOfferRow,
} from '../db';
import {
  submitContactPayment,
  isSubscribed,
  purchaseSubscription,
  PaymentError,
  SubscriptionError,
  renewSubscription as stellarRenewSubscription,
  logTrialOffer as stellarLogTrialOffer,
  cancelSubscriptionOnChain,
} from '../services/stellar';
import { logger } from '../utils/logger';
import { checkWalletOwnership } from '../middleware/requireOwner';
import { broadcaster } from '../services/eventBroadcaster';
import { invalidatePlayerCache } from '../services/cache';
import config from '../config';
import { ErrorCode } from '../utils/errorCodes';
import { insertTrialOffer, getTrialOffers } from '../services/indexer';
import { invokeContract, strVal } from '../utils/contract';
import { isValidIpfsOrHttpsUri } from '../utils/uriValidator';

/**
 * HTTP status for each PaymentError code (Issue #761).
 *
 * | PaymentError code   | HTTP | Meaning                                  |
 * |---------------------|------|------------------------------------------|
 * | INSUFFICIENT_FUNDS  | 402  | Contract error #7 — micro-fee not paid   |
 * | EXPIRED_TRUSTLINE   | 402  | Payment-token trustline missing/expired  |
 * | CONTRACT_PAUSED     | 503  | Contract error #10 — platform paused     |
 * | MISSING_PLAYER      | 404  | Contract error #3 — player not on-chain  |
 * | INVALID_ACCOUNT     | 400  | Missing/malformed wallet or playerId     |
 * | CONTRACT_ERROR      | 502  | Contract rejected the transaction        |
 * | NETWORK_ERROR       | 502  | RPC failure / confirmation timeout       |
 * | UNKNOWN             | 500  | Unclassified failure                     |
 */
export function paymentErrorStatus(code: PaymentError['code']): number {
  switch (code) {
    case 'INSUFFICIENT_FUNDS':
    case 'EXPIRED_TRUSTLINE':
      return 402;
    case 'CONTRACT_PAUSED':
      return 503;
    case 'MISSING_PLAYER':
      return 404;
    case 'INVALID_ACCOUNT':
      return 400;
    case 'CONTRACT_ERROR':
    case 'NETWORK_ERROR':
      return 502;
    case 'UNKNOWN':
      return 500;
  }
}

/**
 * Contact metadata returned once a scout has paid to unlock a player.
 * The player's `metadata_uri` (IPFS CID or HTTPS URL) is the authoritative
 * off-chain contact profile reference; unrelated private/player fields
 * (position, region, progress, activity state) are deliberately not exposed.
 */
function contactDetailsBody(player: {
  player_id: string;
  wallet: string;
  metadata_uri: string | null;
}): { playerId: string; wallet: string; metadataUri: string | null } {
  return {
    playerId: player.player_id,
    wallet: player.wallet,
    metadataUri: player.metadata_uri,
  };
}

// ─── Validation schemas ────────────────────────────────────────────────────────

export const trialOfferSchema = z.object({
  playerId: z.string().min(1),
  detailsUri: z
    .string()
    .min(1)
    .refine(isValidIpfsOrHttpsUri, 'detailsUri must be a valid IPFS (ipfs://) or HTTPS URI'),
}).strict();

/**
 * Body schema for POST /scouts/:wallet/contacts/:playerId/unlock.
 * Currently the unlock operation only uses URL params (wallet, playerId),
 * so the body is intentionally empty. Defining it explicitly ensures
 * unexpected fields are stripped and the route is ready for future body fields.
 */
export const unlockContactSchema = z.object({}).strict();

export const subscribeSchema = z.object({
  tier: z.enum(['basic', 'premium']),
  duration: z.number().int().min(1).max(365),
}).strict();

// ─── Access helpers ────────────────────────────────────────────────────────────

/**
 * Returns the grace-period-aware expiry threshold.
 * A subscription is considered "live" until expiresAt + gracePeriodSeconds.
 */
function gracePeriodSeconds(): number {
  return config.subscriptionGracePeriodHours * 3600;
}

/**
 * Returns true if the scout currently has paid access to the player —
 * either an active (or grace-period) subscription or a previously unlocked contact.
 */
async function scoutHasPlayerAccess(scoutWallet: string, playerId: string): Promise<boolean> {
  // 1. On-chain subscription check (stub currently returns inactive)
  const onChain = await isSubscribed(scoutWallet);
  if (onChain.active) return true;

  const now = Math.floor(Date.now() / 1000);
  const graceThreshold = now - gracePeriodSeconds();

  // 2. Local subscriptions table (authoritative for renewal/cancellation state)
  const localSub = await getLatestSubscription(scoutWallet);
  if (localSub && localSub.expires_at > graceThreshold) return true;

  // 3. Indexed scout_subscribed events (fallback for pre-table records)
  const subs = queryEvents('scout_subscribed').filter((e) => e.payload.scout === scoutWallet);
  const latestSub = subs.at(-1);
  if (latestSub) {
    const expiresAt = latestSub.payload.subscription_expiry as number;
    if (expiresAt > graceThreshold) return true;
  }

  // 4. Dedicated contact_unlocks table
  return await hasContactUnlock(scoutWallet, playerId);
}

// ─── GET /api/scouts/:wallet/subscription ─────────────────────────────────────

/** GET /api/scouts/:wallet/subscription */
export async function getSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
  const {wallet} = req.params as {wallet: string};

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
  const subs = queryEvents('scout_subscribed').filter((e) => e.payload.scout === wallet);
  const latest = subs.at(-1);
  if (!latest) {
    res.json({
      success: true,
      data: { active: false, tier: null, expiresAt: null, remainingDays: 0, gracePeriodActive: false },
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
    const {wallet} = req.params as {wallet: string};
    // Ownership is enforced by requireWalletOwner() at the route level; the
    // shared guard is re-invoked here so direct callers (unit tests) get the
    // same protection without duplicating the comparison inline.
    // validateAddress: false preserves the historical behavior of this
    // endpoint, which never validated the address format.
    if (!checkWalletOwnership(req, res, { validateAddress: false })) return;

    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request body' });
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

    logger.info(`[scout] action=new_subscription scout=${wallet} tier=${tier} duration=${duration} expiry=${result.expiresAt}`);

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
export async function renewSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
try {
    const {wallet} = req.params as {wallet: string};
    const parsed = subscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request body' });
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

      logger.info(`[scout] action=renew_subscription scout=${wallet} tier=${tier} duration=${duration} newExpiry=${result.expiresAt}`);
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

      logger.info(`[scout] action=new_subscription_via_put scout=${wallet} tier=${tier} duration=${duration} expiry=${result.expiresAt}`);
      res.status(201).json({ success: true, data: result });
    }
  } catch (err) {
    if (err instanceof PaymentError) {
      res.status(402).json({ success: false, error: err.message, code: err.code });
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
export async function cancelSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
try {
    const {wallet} = req.params as {wallet: string};

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

    logger.info(`[scout] action=cancel_subscription scout=${wallet} subId=${existingSub.id} txId=${onChainResult.transactionId}`);

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

// ─── GET /api/scouts/:wallet/contacts ─────────────────────────────────────────

/** GET /api/scouts/:wallet/contacts */
export async function getUnlockedContacts(req: Request, res: Response, next: NextFunction): Promise<void> {
  const {wallet} = req.params as {wallet: string};
  const { playerId } = req.query as { playerId?: string };

  let contacts = await getContactUnlocksByScout(wallet);

  if (playerId) {
    contacts = contacts.filter((c) => c.player_id === playerId);
  }

  res.json({
    success: true,
    data: contacts.map((c) => ({
      playerId: c.player_id,
      contact_status: 'unlocked',
      unlockedAt: c.unlocked_at,
    })),
  });
}

// ─── POST /api/scouts/:wallet/contacts/:playerId/unlock ───────────────────────

/** POST /api/scouts/:wallet/contacts/:playerId/unlock */
export async function unlockContact(req: Request, res: Response, next: NextFunction): Promise<void> {
try {
    const {wallet, playerId} = req.params as {wallet: string, playerId: string};
    if (!wallet || !playerId) {
      res.status(400).json({ success: false, error: 'wallet and playerId are required', code: ErrorCode.VALIDATION_ERROR });
      return;
    }

    // Ownership is enforced by requireWalletOwner() at the route level; the
    // shared guard is re-invoked here so direct callers (unit tests) get the
    // same protection without duplicating the comparison inline.
    if (!checkWalletOwnership(req, res)) {
      logger.warn(`[scout] action=unlock_contact_denied scout=${wallet} playerId=${playerId} reason=wallet_mismatch`);
      return;
    }

    // Validate the requested player before any payment is considered.
    const player = await getPlayerById(playerId);
    if (!player) {
      res.status(404).json({ success: false, error: 'Player not found', code: ErrorCode.PLAYER_NOT_FOUND });
      return;
    }

    // A scout must never pay to unlock their own profile.
    if (player.wallet === wallet) {
      logger.warn(`[scout] action=unlock_contact_denied scout=${wallet} playerId=${playerId} reason=self_unlock`);
      res.status(400).json({
        success: false,
        error: 'Cannot unlock your own profile',
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }

    // Idempotent: a player already unlocked by this scout must not be charged again.
    // Return the cached contact details so the client can use them immediately.
    if (await hasContactUnlock(wallet, playerId)) {
      logger.info(`[scout] action=unlock_contact_already_unlocked scout=${wallet} playerId=${playerId}`);
      res.json({
        success: true,
        data: {
          alreadyUnlocked: true,
          ...contactDetailsBody(player),
        },
      });
      return;
    }

    logger.info(`[scout] action=unlock_contact_attempt scout=${wallet} playerId=${playerId}`);

    // Confirmed-settlement gate: submitContactPayment only resolves after the
    // Soroban RPC reports a SUCCESSFUL getTransaction for the submitted tx, so
    // the unlock row below is never written for an unconfirmed payment.
    const result = await submitContactPayment(wallet, playerId);
    await insertContactUnlock({
      scout_wallet: wallet,
      player_id: playerId,
      tx_hash: result.transactionId,
      unlocked_at: Math.floor(Date.now() / 1000),
    });

    // Player state changed (contact_unlocked) — invalidate player-list caches
    // after the persistence succeeded so subsequent list queries stay fresh.
    await invalidatePlayerCache();

    // Notify connected SSE clients only after confirmed settlement AND the
    // unlock row has been persisted. A notification failure must not roll
    // back the confirmed blockchain settlement, so broadcast is fire-and-forget
    // (the EventBroadcaster never throws for subscriber send errors).
    broadcaster.broadcast({
      type: 'contact_unlocked',
      payload: {
        scout: wallet,
        player_id: playerId,
        tx_hash: result.transactionId,
        timestamp: new Date().toISOString(),
      },
    });

    res.json({
      success: true,
      data: {
        ...contactDetailsBody(player),
        transactionId: result.transactionId,
        status: result.status,
      },
    });
  } catch (err) {
    if (err instanceof PaymentError) {
      res.status(paymentErrorStatus(err.code)).json({ success: false, error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}

// ─── GET/POST /api/scouts/:wallet/trial-offers (#285) ──────────────────────────

/** GET /api/scouts/:wallet/trial-offers — on-chain trial offer event history */
export async function listTrialOffers(req: Request, res: Response, next: NextFunction): Promise<void> {
  const {wallet} = req.params as {wallet: string};
  res.json({ success: true, data: await getTrialOffers(wallet) });
}

/**
 * POST /api/scouts/:wallet/trial-offers — submit a trial offer on-chain and index it locally.
 *
 * This is the **canonical** implementation of "a scout submits a trial offer for a player".
 * The legacy `POST /api/scouts/:wallet/trial-offer` route wires to this same handler,
 * so both routes share one code path — validation, on-chain submission,
 * `trial_offer_events` + `trial_offers` persistence, Elite Tier promotion and SSE broadcast.
 */
export async function createTrialOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
try {
    const {wallet} = req.params as {wallet: string};

    const parsed = trialOfferSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid request body' });
      return;
    }
    const { playerId, detailsUri } = parsed.data;

    // Verify player exists
    const playerExists = queryEvents('player_registered').some((e) => e.payload.player_id === playerId);
    if (!playerExists) {
      res.status(404).json({ success: false, error: 'Player not found', code: ErrorCode.PLAYER_NOT_FOUND });
      return;
    }

    // Check scout has active subscription or prior contact unlock
    const hasAccess = await scoutHasPlayerAccess(wallet, playerId);
    if (!hasAccess) {
      res.status(402).json({
        success: false,
        error: 'Scout must be subscribed or have paid the contact fee for this player',
        code: ErrorCode.SUBSCRIPTION_REQUIRED,
      });
      return;
    }

    logger.info(`[scout] action=create_trial_offer scout=${wallet} playerId=${playerId} detailsUri=${detailsUri}`);

    // Submit on-chain via Soroban
    const result = await stellarLogTrialOffer(wallet, playerId, detailsUri);
    const createdAt = Math.floor(Date.now() / 1000);
    const offerId = `offer-${createdAt}-${playerId}`;

    // Persist to trial_offer_events (indexer event log, deduped by tx_hash)
    await insertTrialOffer(wallet, playerId, detailsUri, result.transactionId, createdAt);

    // Persist to trial_offers (offer/response workflow table)
    await insertTrialOfferRow({
      offer_id: offerId,
      scout_wallet: wallet,
      player_id: playerId,
      details_uri: detailsUri,
      created_at: createdAt,
    });

    // Promote player to Elite Tier (Level 3)
    await updatePlayerProgress(playerId, 3);

    // Emit SSE: trial offer logged
    broadcaster.broadcast({
      type: 'trial_offer_logged',
      payload: {
        offer_id: offerId,
        scout: wallet,
        player_id: playerId,
        details_uri: detailsUri,
        tx_hash: result.transactionId,
        timestamp: new Date().toISOString(),
      },
    });

    // Emit SSE: tier promoted to Elite
    broadcaster.broadcast({
      type: 'milestone_approved',
      payload: {
        player_id: playerId,
        new_tier: 3,
        reason: 'trial_offer_logged',
        timestamp: new Date().toISOString(),
      },
    });

    res.status(201).json({
      success: true,
      data: {
        offerId,
        transactionId: result.transactionId,
        scout: wallet,
        playerId,
        detailsUri,
        createdAt,
        tierPromoted: true,
        newTier: 3,
      },
    });
  } catch (err) {
    if (err instanceof PaymentError) {
      res.status(402).json({ success: false, error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}

// ─── GET /api/scouts/:wallet/payments ─────────────────────────────────────────

/**
 * Payment record shape returned by GET /api/scouts/:wallet/payments.
 * Covers both contact_unlock and subscription payment types.
 */
export interface PaymentRecord {
  id: string | null;
  type: 'contact_unlock' | 'subscription';
  amount_xlm: string;
  player_id: string | null;
  tier: string | null;
  tx_hash: string | null;
  created_at: string;
  // legacy aliases kept for backwards-compat
  transactionId: string | null;
  amount: string;
  token: string;
  timestamp: string;
}

const paymentHistoryQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  type: z.enum(['subscription', 'contact_unlock']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  format: z.enum(['json', 'csv']).default('json'),
});

/** GET /api/scouts/:wallet/payments — payment history */
export async function getPaymentHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  const {wallet} = req.params as {wallet: string};

  const parsed = paymentHistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.errors[0]?.message ?? 'Invalid query parameters', code: ErrorCode.VALIDATION_ERROR });
    return;
  }
  const { from, to, type, page, pageSize, format } = parsed.data;

  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;

  if (fromDate && isNaN(fromDate.getTime())) {
    res.status(400).json({ success: false, error: 'Invalid from date', code: ErrorCode.VALIDATION_ERROR });
    return;
  }
  if (toDate && isNaN(toDate.getTime())) {
    res.status(400).json({ success: false, error: 'Invalid to date', code: ErrorCode.VALIDATION_ERROR });
    return;
  }

  // ── Build combined payment list ───────────────────────────────────────────
  const payments: PaymentRecord[] = [];

  // Contact unlock payments
  if (!type || type === 'contact_unlock') {
    const unlocks = await getContactUnlocksByScout(wallet);
    for (const u of unlocks) {
      const ts = new Date(u.unlocked_at * 1000).toISOString();
      if (fromDate && new Date(ts) < fromDate) continue;
      if (toDate && new Date(ts) > toDate) continue;
      payments.push({
        id: u.tx_hash ?? null,
        type: 'contact_unlock',
        amount_xlm: '0',
        player_id: u.player_id,
        tier: null,
        tx_hash: u.tx_hash ?? null,
        created_at: ts,
        // legacy aliases
        transactionId: u.tx_hash ?? null,
        amount: '0',
        token: 'XLM',
        timestamp: ts,
      });
    }

    // Also pull from contact_unlocked contract events for tx_hash + fee info
    // (these may contain fee amounts that the DB row doesn't store)
    const contactEvents = queryEvents('contact_unlocked').filter(
      (e) => e.payload.scout === wallet,
    );
    for (const e of contactEvents) {
      const ts = (e.payload.timestamp as string | undefined) ?? new Date(0).toISOString();
      if (fromDate && new Date(ts) < fromDate) continue;
      if (toDate && new Date(ts) > toDate) continue;
      const txHash = (e.payload.tx_hash as string | undefined) ?? null;
      const playerId = (e.payload.player_id as string | undefined) ?? (e.payload.playerId as string | undefined) ?? null;
      const fee = (e.payload.fee ?? '0') as string;
      // A DB row for this tx may already be in the list (pushed above,
      // always with amount '0' since the contact_unlocks table doesn't
      // store fee). Enrich it with the event's fee instead of skipping —
      // otherwise the fee info this loop exists to attach never reaches
      // the DB-sourced entry.
      const existing = txHash
        ? payments.find((p) => p.type === 'contact_unlock' && p.tx_hash === txHash)
        : undefined;
      if (existing) {
        existing.amount = fee;
        existing.amount_xlm = fee;
      } else {
        payments.push({
          id: txHash,
          type: 'contact_unlock',
          amount_xlm: fee,
          player_id: playerId,
          tier: null,
          tx_hash: txHash,
          created_at: ts,
          transactionId: txHash,
          amount: fee,
          token: 'XLM',
          timestamp: ts,
        });
      }
    }
  }

  // Subscription payments
  if (!type || type === 'subscription') {
    const subs = await getSubscriptionsByScout(wallet);
    for (const s of subs) {
      const ts = new Date(s.created_at * 1000).toISOString();
      if (fromDate && new Date(ts) < fromDate) continue;
      if (toDate && new Date(ts) > toDate) continue;
      payments.push({
        id: String(s.id),
        type: 'subscription',
        amount_xlm: '0',
        player_id: null,
        tier: s.tier,
        tx_hash: null,
        created_at: ts,
        // legacy aliases
        transactionId: null,
        amount: '0',
        token: 'XLM',
        timestamp: ts,
      });
    }
  }

  // Sort by created_at descending (newest first)
  payments.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const total = payments.length;

  // ── CSV export ────────────────────────────────────────────────────────────
  if (format === 'csv') {
    const csvHeader = 'id,type,amount_xlm,player_id,tier,tx_hash,created_at\n';
    const csvRows = payments.map((p) =>
      [
        p.id ?? '',
        p.type,
        p.amount_xlm,
        p.player_id ?? '',
        p.tier ?? '',
        p.tx_hash ?? '',
        p.created_at,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
    res.status(200).send(csvHeader + csvRows.join('\n'));
    return;
  }

  // ── Paginated JSON response ───────────────────────────────────────────────
  const offset = (page - 1) * pageSize;
  const pageData = payments.slice(offset, offset + pageSize);

  res.json({ success: true, data: pageData, total, page, pageSize });
}

/** GET /api/scouts/:wallet/contacts/:playerId */
export async function getContactDetails(req: Request, res: Response, next: NextFunction): Promise<void> {
  const {wallet, playerId} = req.params as {wallet: string, playerId: string};

  const player = await getPlayerById(playerId);
  if (!player) {
    res.status(404).json({ success: false, error: 'Player not found' });
    return;
  }

  const hasUnlocked = await hasContactUnlock(wallet, playerId);

  if (!hasUnlocked) {
    res.status(403).json({ success: false, error: 'Contact not unlocked' });
    return;
  }

  res.json({
    success: true,
    data: contactDetailsBody(player),
  });
}
