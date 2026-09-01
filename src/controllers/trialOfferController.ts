import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getTrialOfferById, respondToTrialOffer, insertTrialOffer, cancelTrialOffer, TrialOfferRow } from '../db';
import { queryEvents } from '../db';
import { logger } from '../utils/logger';
import { broadcaster } from '../services/eventBroadcaster';
import config from '../config';

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const rejectOfferSchema = z.object({
  reason: z.string().max(500).optional(),
}).strict();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the player's wallet from their playerId.
 * We look up the player_registered event for their wallet address.
 */
function getPlayerWallet(playerId: string): string | null {
  const event = queryEvents('player_registered').find(
    (e) => e.payload.player_id === playerId,
  );
  return event ? (event.payload.wallet as string) : null;
}

/**
 * Shared resolution step for the accept and reject handlers (#1034).
 *
 * Runs the checks both responses require, in the order they were previously
 * duplicated in each handler:
 *   1. the playerId maps to a registered player            → 404 otherwise
 *   2. the authenticated account owns that player profile  → 403 otherwise
 *   3. the offer row exists, seeding it from the indexed on-chain
 *      `trial_offer_logged` event when the row is missing  → 404 otherwise
 *   4. the offer is addressed to this player               → 403 otherwise
 *   5. the offer has not been responded to yet             → 409 otherwise
 *
 * On failure the error response is written here and `null` is returned — callers
 * must return immediately. On success the resolved offer row is returned and the
 * caller performs only its accept/reject-specific work.
 *
 * `action` only labels the denial log line ('accept' | 'reject').
 */
async function resolveOwnedPendingOffer(
  playerId: string,
  offerId: string,
  req: Request,
  res: Response,
  action: 'accept' | 'reject',
): Promise<TrialOfferRow | null> {
  // Verify ownership: the authenticated account must own this playerId
  const playerWallet = getPlayerWallet(playerId);
  if (!playerWallet) {
    res.status(404).json({ success: false, error: 'Player not found' });
    return null;
  }
  if (req.account !== playerWallet) {
    logger.warn(
      `[trialOffer] ${action}_denied offerId=${offerId} playerId=${playerId} reason=not_owner account=${req.account}`,
    );
    res.status(403).json({ success: false, error: 'Forbidden: you do not own this player profile' });
    return null;
  }

  // Ensure the offer exists and belongs to this player
  let offer = await getTrialOfferById(offerId);

  if (!offer) {
    // Try to seed from on-chain indexed events (backward compatibility)
    const event = queryEvents('trial_offer_logged').find(
      (e) => e.payload.offer_id === offerId || e.payload.player_id === playerId,
    );
    if (!event) {
      res.status(404).json({ success: false, error: 'Trial offer not found' });
      return null;
    }
    // Insert the offer from on-chain data so we can record the response
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = config.trialOfferTtlMs > 0
      ? now + Math.floor(config.trialOfferTtlMs / 1000)
      : null;
    await insertTrialOffer({
      offer_id: offerId,
      scout_wallet: event.payload.scout as string,
      player_id: playerId,
      details_uri: (event.payload.details_uri ?? '') as string,
      created_at: now,
      expires_at: expiresAt,
    });
    offer = await getTrialOfferById(offerId);
  }

  if (!offer) {
    res.status(404).json({ success: false, error: 'Trial offer not found' });
    return null;
  }

  if (offer.player_id !== playerId) {
    res.status(403).json({ success: false, error: 'Forbidden: offer does not belong to this player' });
    return null;
  }

  // Check expiry before status — an expired offer is distinct from one that
  // was already responded to and gives a clearer error message.
  const nowSec = Math.floor(Date.now() / 1000);
  if (offer.expires_at !== null && offer.expires_at !== undefined && nowSec > offer.expires_at) {
    res.status(410).json({
      success: false,
      error: 'Trial offer has expired',
      data: { status: 'expired', expiresAt: offer.expires_at },
    });
    return null;
  }

  // Check cancellation
  if (offer.cancelled_at !== null && offer.cancelled_at !== undefined) {
    res.status(410).json({
      success: false,
      error: 'Trial offer has been withdrawn by the scout',
      data: { status: 'cancelled', cancelledAt: offer.cancelled_at },
    });
    return null;
  }

  if (offer.status !== 'pending') {
    res.status(409).json({
      success: false,
      error: `Offer already ${offer.status}`,
      data: { status: offer.status, respondedAt: offer.responded_at },
    });
    return null;
  }

  return offer;
}

// ─── POST /api/players/:playerId/trial-offers/:offerId/accept ─────────────────

/**
 * Accept a trial offer addressed to the authenticated player.
 * - 200: offer accepted
 * - 403: non-owner player attempting to respond
 * - 404: offer not found
 * - 409: offer already responded to
 */
export async function acceptTrialOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  const {playerId, offerId} = req.params as {playerId: string, offerId: string};

  const offer = await resolveOwnedPendingOffer(playerId, offerId, req, res, 'accept');
  if (!offer) return;

  const now = Math.floor(Date.now() / 1000);
  await respondToTrialOffer({ offer_id: offerId, status: 'accepted', responded_at: now });

  logger.info(`[trialOffer] accepted offerId=${offerId} playerId=${playerId}`);

  // Notify the scout via SSE that their trial offer was accepted.
  broadcaster.broadcast({
    type: 'trial_offer_accepted',
    payload: {
      offer_id: offerId,
      player_id: playerId,
      scout: offer.scout_wallet,
      responded_at: now,
    },
  });

  // NOTE: On-chain record of the response is a future step.
  // When the Soroban contract supports `respond_to_offer(offer_id, accepted: bool)`,
  // invoke it here via stellarService.respondToTrialOffer(offerId, 'accepted').

  res.status(200).json({
    success: true,
    data: {
      offerId,
      playerId,
      status: 'accepted',
      respondedAt: now,
    },
  });
}

// ─── POST /api/players/:playerId/trial-offers/:offerId/reject ─────────────────

/**
 * Reject a trial offer addressed to the authenticated player.
 * - 200: offer rejected
 * - 403: non-owner player attempting to respond
 * - 404: offer not found
 * - 409: offer already responded to
 */
export async function rejectTrialOffer(req: Request, res: Response, next: NextFunction): Promise<void> {
  const {playerId, offerId} = req.params as {playerId: string, offerId: string};

  // Reject-specific: parse the optional reason before any lookup or seeding,
  // so an invalid body can never reach a side effect. The route also applies
  // validateBody(rejectOfferSchema), so this is the direct-invocation guard.
  const bodyParsed = rejectOfferSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ success: false, error: bodyParsed.error.errors[0]?.message ?? 'Invalid request body' });
    return;
  }
  const reason = bodyParsed.data.reason;

  const offer = await resolveOwnedPendingOffer(playerId, offerId, req, res, 'reject');
  if (!offer) return;

  const now = Math.floor(Date.now() / 1000);
  await respondToTrialOffer({ offer_id: offerId, status: 'rejected', reject_reason: reason, responded_at: now });

  logger.info(`[trialOffer] rejected offerId=${offerId} playerId=${playerId} reason=${reason ?? 'none'}`);

  // Notify the scout via SSE that their trial offer was rejected.
  broadcaster.broadcast({
    type: 'trial_offer_rejected',
    payload: {
      offer_id: offerId,
      player_id: playerId,
      scout: offer.scout_wallet,
      reason: reason ?? null,
      responded_at: now,
    },
  });

  // NOTE: On-chain record of the response is a future step (see acceptTrialOffer above).

  res.status(200).json({
    success: true,
    data: {
      offerId,
      playerId,
      status: 'rejected',
      reason: reason ?? null,
      respondedAt: now,
    },
  });
}

// ─── DELETE /api/scouts/:wallet/trial-offers/:offerId ─────────────────────────

/**
 * Cancel (withdraw) a pending trial offer submitted by the authenticated scout.
 *
 * Only the originating scout may cancel their own offer, and only while it is
 * still pending — i.e. the player has not yet accepted or rejected it.
 *
 * After cancellation the player's accept/reject attempts return 410 Gone.
 *
 * - 200: offer cancelled
 * - 403: authenticated wallet is not the offer's originating scout
 * - 404: offer not found
 * - 409: offer already responded to (accepted/rejected) or already cancelled
 */
export async function cancelTrialOfferHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  const { offerId } = req.params as { offerId: string };
  const scoutWallet = req.params.wallet as string;

  const offer = await getTrialOfferById(offerId);

  if (!offer) {
    res.status(404).json({ success: false, error: 'Trial offer not found' });
    return;
  }

  if (offer.scout_wallet !== scoutWallet) {
    logger.warn(
      `[trialOffer] cancel_denied offerId=${offerId} reason=not_owner account=${req.account}`,
    );
    res.status(403).json({ success: false, error: 'Forbidden: you did not submit this trial offer' });
    return;
  }

  if (offer.status !== 'pending') {
    res.status(409).json({
      success: false,
      error: `Cannot cancel an offer that is already ${offer.status}`,
      data: { status: offer.status },
    });
    return;
  }

  if (offer.cancelled_at !== null && offer.cancelled_at !== undefined) {
    res.status(409).json({
      success: false,
      error: 'Offer has already been cancelled',
      data: { status: 'cancelled', cancelledAt: offer.cancelled_at },
    });
    return;
  }

  const cancelled = await cancelTrialOffer(offerId, scoutWallet);

  if (!cancelled) {
    // Race: another request beat us to it
    res.status(409).json({
      success: false,
      error: 'Offer could not be cancelled — it may have just been responded to',
    });
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  logger.info(`[trialOffer] cancelled offerId=${offerId} scout=${scoutWallet}`);

  broadcaster.broadcast({
    type: 'trial_offer_cancelled',
    payload: {
      offer_id: offerId,
      player_id: offer.player_id,
      scout: scoutWallet,
      cancelled_at: now,
    },
  });

  res.status(200).json({
    success: true,
    data: {
      offerId,
      status: 'cancelled',
      cancelledAt: now,
    },
  });
}
