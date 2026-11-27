import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getPlayerById,
  insertContactUnlock,
  getContactUnlocksByScout,
  hasContactUnlock,
} from '../../db';
import {
  submitContactPayment,
  PaymentError,
} from '../../services/stellar';
import { logger } from '../../utils/logger';
import { checkWalletOwnership } from '../../middleware/requireOwner';
import { broadcaster } from '../../services/eventBroadcaster';
import { invalidatePlayerCache } from '../../services/cache';
import { ErrorCode } from '../../utils/errorCodes';
import { paymentErrorStatus } from './helpers';

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

/**
 * Body schema for POST /scouts/:wallet/contacts/:playerId/unlock.
 * Currently the unlock operation only uses URL params (wallet, playerId),
 * so the body is intentionally empty. Defining it explicitly ensures
 * unexpected fields are stripped and the route is ready for future body fields.
 */
export const unlockContactSchema = z.object({}).strict().default({});

// ─── GET /api/scouts/:wallet/contacts ─────────────────────────────────────────

/** GET /api/scouts/:wallet/contacts */
export async function getUnlockedContacts(req: Request, res: Response, _next: NextFunction): Promise<void> {
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

/** GET /api/scouts/:wallet/contacts/:playerId */
export async function getContactDetails(req: Request, res: Response, _next: NextFunction): Promise<void> {
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
