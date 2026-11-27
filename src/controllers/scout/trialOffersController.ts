import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  queryEvents,
  getLatestSubscription,
  hasContactUnlock,
  updatePlayerProgress,
  insertTrialOffer as insertTrialOfferRow,
} from '../../db';
import {
  isSubscribed,
  logTrialOffer as stellarLogTrialOffer,
  PaymentError,
} from '../../services/stellar';
import { logger } from '../../utils/logger';
import { broadcaster } from '../../services/eventBroadcaster';
import { ErrorCode } from '../../utils/errorCodes';
import { insertTrialOffer, getTrialOffers } from '../../services/indexer';
import { isValidIpfsOrHttpsUri } from '../../utils/uriValidator';
import { paymentErrorStatus, gracePeriodSeconds } from './helpers';

// ─── Validation schemas ────────────────────────────────────────────────────────

export const trialOfferSchema = z
  .object({
    playerId: z.string().min(1),
    detailsUri: z
      .string()
      .min(1)
      .refine(isValidIpfsOrHttpsUri, 'detailsUri must be a valid IPFS (ipfs://) or HTTPS URI'),
  })
  .strict();

// ─── Access helpers ────────────────────────────────────────────────────────────

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
  const subs = queryEvents('scout_subscribed', { payloadFilter: { scout: scoutWallet } });
  const latestSub = subs.at(-1);
  if (latestSub) {
    const expiresAt = latestSub.payload.subscription_expiry as number;
    if (expiresAt > graceThreshold) return true;
  }

  // 4. Dedicated contact_unlocks table
  return await hasContactUnlock(scoutWallet, playerId);
}

// ─── GET/POST /api/scouts/:wallet/trial-offers (#285) ──────────────────────────

/** GET /api/scouts/:wallet/trial-offers — on-chain trial offer event history */
export async function listTrialOffers(
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> {
  const { wallet } = req.params as { wallet: string };
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
export async function createTrialOffer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { wallet } = req.params as { wallet: string };

    const parsed = trialOfferSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
      return;
    }
    const { playerId, detailsUri } = parsed.data;

    // Verify player exists
    const playerExists =
      queryEvents('player_registered', {
        payloadFilter: { player_id: playerId },
        limit: 1,
        offset: 0,
      }).length > 0;
    if (!playerExists) {
      res
        .status(404)
        .json({ success: false, error: 'Player not found', code: ErrorCode.PLAYER_NOT_FOUND });
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

    logger.info(
      `[scout] action=create_trial_offer scout=${wallet} playerId=${playerId} detailsUri=${detailsUri}`,
    );

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
      res
        .status(paymentErrorStatus(err.code))
        .json({ success: false, error: err.message, code: err.code });
      return;
    }
    next(err);
  }
}
