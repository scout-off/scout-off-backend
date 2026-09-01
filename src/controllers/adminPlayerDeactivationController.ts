/**
 * Admin player deactivation / reactivation controller.
 *
 * POST /api/admin/players/:playerId/deactivate
 *   - Requires admin JWT.
 *   - Accepts { reason: string } body (required).
 *   - Soft-deletes the player (sets is_active = 0, deactivation_reason).
 *   - Cancels all pending milestones for the player.
 *   - Emits a player_deactivated SSE event to every scout who has unlocked
 *     the player's contact details, and to the player themselves.
 *   - Records a player_deactivated audit log entry.
 *
 * POST /api/admin/players/:playerId/reactivate
 *   - Clears is_active and deactivation_reason.
 *   - Records a player_reactivated audit log entry.
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getPlayerById,
  deactivatePlayerWithReason,
  reactivatePlayerWithReason,
  cancelPendingMilestonesForPlayer,
  getContactUnlocksByPlayer,
} from '../db';
import { invalidatePlayerCache } from '../services/cache';
import { broadcaster } from '../services/eventBroadcaster';
import { logAuditEvent } from '../services/audit';
import { logger } from '../utils/logger';
import { playerIdSchema } from '../utils/playerIdValidator';
import { ErrorCode } from '../utils/errorCodes';
import { sanitizeInput } from '../utils/sanitizer';

// ─── Schemas ──────────────────────────────────────────────────────────────────

export const deactivateBodySchema = z.object({
  reason: z
    .string({ required_error: 'reason is required' })
    .min(1, 'reason is required')
    .max(500, 'reason must be 500 characters or fewer')
    .transform((s) => s.trim()),
}).strict();

// ─── POST /api/admin/players/:playerId/deactivate ─────────────────────────────

export async function adminDeactivatePlayer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // ── Validate playerId path param ─────────────────────────────────────────
  const idResult = playerIdSchema.safeParse(req.params.playerId as string);
  if (!idResult.success) {
    res.status(400).json({
      success: false,
      error: idResult.error.errors[0]?.message ?? 'Invalid playerId',
      code: ErrorCode.VALIDATION_ERROR,
    });
    return;
  }
  const playerId = sanitizeInput(req.params.playerId as string);

  // ── Validate body ────────────────────────────────────────────────────────
  const bodyResult = deactivateBodySchema.safeParse(req.body);
  if (!bodyResult.success) {
    res.status(400).json({
      success: false,
      error: bodyResult.error.errors[0]?.message ?? 'reason is required',
      code: ErrorCode.VALIDATION_ERROR,
    });
    return;
  }
  const { reason } = bodyResult.data;

  // ── Fetch player ─────────────────────────────────────────────────────────
  const player = await getPlayerById(playerId);
  if (!player) {
    res.status(404).json({
      success: false,
      error: 'Player not found',
      code: ErrorCode.PLAYER_NOT_FOUND,
    });
    return;
  }

  if (player.is_active === 0) {
    res.status(409).json({
      success: false,
      error: 'Player is already deactivated',
    });
    return;
  }

  // ── Soft-delete ──────────────────────────────────────────────────────────
  await deactivatePlayerWithReason(playerId, reason);

  // ── Cancel pending milestones ────────────────────────────────────────────
  const cancelledCount = await cancelPendingMilestonesForPlayer(playerId);
  logger.info(
    `[adminDeactivate] cancelled ${cancelledCount} pending milestone(s) for player=${playerId}`,
  );

  // ── Invalidate player cache ──────────────────────────────────────────────
  await invalidatePlayerCache(playerId);

  // ── SSE: notify connected scouts who unlocked this player ─────────────────
  // Each unlock row carries the scout_wallet; we broadcast individually so
  // the relevance filter in eventBroadcaster routes to the right subscriber.
  const unlocks = await getContactUnlocksByPlayer(playerId);
  const notifiedScouts = new Set<string>();

  for (const unlock of unlocks) {
    broadcaster.broadcast({
      type: 'player_deactivated',
      payload: {
        player_id: playerId,
        wallet: player.wallet,
        reason,
        scout_wallet: unlock.scout_wallet,
        deactivated_at: new Date().toISOString(),
      },
    });
    notifiedScouts.add(unlock.scout_wallet);
  }

  // Also notify the player themselves.
  broadcaster.broadcast({
    type: 'player_deactivated',
    payload: {
      player_id: playerId,
      wallet: player.wallet,
      reason,
      deactivated_at: new Date().toISOString(),
    },
  });

  // ── Audit log ────────────────────────────────────────────────────────────
  const adminWallet = req.account ?? 'unknown';
  await logAuditEvent({
    action: 'player_deactivated',
    adminWallet,
    timestamp: new Date().toISOString(),
    queryParams: {
      player_id: playerId,
      reason,
      cancelled_milestones: cancelledCount,
      notified_scouts: notifiedScouts.size,
    },
  }).catch(() => {});

  logger.info(
    `[adminDeactivate] player=${playerId} deactivated by admin=${adminWallet} ` +
      `scouts_notified=${notifiedScouts.size}`,
  );

  res.json({
    success: true,
    message: 'Player deactivated successfully',
    data: {
      playerId,
      cancelledMilestones: cancelledCount,
      notifiedScouts: notifiedScouts.size,
    },
  });
}

// ─── POST /api/admin/players/:playerId/reactivate ─────────────────────────────

export async function adminReactivatePlayer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // ── Validate playerId ────────────────────────────────────────────────────
  const idResult = playerIdSchema.safeParse(req.params.playerId as string);
  if (!idResult.success) {
    res.status(400).json({
      success: false,
      error: idResult.error.errors[0]?.message ?? 'Invalid playerId',
      code: ErrorCode.VALIDATION_ERROR,
    });
    return;
  }
  const playerId = sanitizeInput(req.params.playerId as string);

  // ── Fetch player ─────────────────────────────────────────────────────────
  const player = await getPlayerById(playerId);
  if (!player) {
    res.status(404).json({
      success: false,
      error: 'Player not found',
      code: ErrorCode.PLAYER_NOT_FOUND,
    });
    return;
  }

  if (player.is_active === 1) {
    res.status(409).json({
      success: false,
      error: 'Player is already active',
    });
    return;
  }

  // ── Reactivate ───────────────────────────────────────────────────────────
  await reactivatePlayerWithReason(playerId);

  // ── Invalidate player cache ──────────────────────────────────────────────
  await invalidatePlayerCache(playerId);

  // ── SSE: notify the player ────────────────────────────────────────────────
  broadcaster.broadcast({
    type: 'player_reactivated',
    payload: {
      player_id: playerId,
      wallet: player.wallet,
      reactivated_at: new Date().toISOString(),
    },
  });

  // ── Audit log ────────────────────────────────────────────────────────────
  const adminWallet = req.account ?? 'unknown';
  await logAuditEvent({
    action: 'player_reactivated',
    adminWallet,
    timestamp: new Date().toISOString(),
    queryParams: { player_id: playerId },
  }).catch(() => {});

  logger.info(
    `[adminReactivate] player=${playerId} reactivated by admin=${adminWallet}`,
  );

  res.json({
    success: true,
    message: 'Player reactivated successfully',
    data: { playerId },
  });
}
