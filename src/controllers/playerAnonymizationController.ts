/**
 * Player data anonymization controller (GDPR right-to-erasure).
 *
 * POST /api/players/:playerId/anonymize
 *   - Requires player JWT + owner check.
 *   - Scrubs PII from off-chain stores this backend controls (see docs/data-privacy.md).
 *   - Unpins IPFS content the backend pinned (metadata, evidence, etc.).
 *   - Deactivates the player (is_active = 0).
 *   - Records an audit log entry so the anonymization event itself is tracked.
 *   - Does NOT erase on-chain Soroban contract state (immutable by design).
 */

import { Request, Response, NextFunction } from 'express';
import {
  getPlayerById,
  getPlayerProfileHistory,
  getDriver,
} from '../db';
import { invalidateMilestoneCache, invalidatePlayerCache } from '../services/cache';
import { unpinCid } from '../services/ipfs';
import { logAuditEvent } from '../services/audit';
import { logger } from '../utils/logger';
import { playerIdSchema } from '../utils/playerIdValidator';
import { ErrorCode } from '../utils/errorCodes';
import { redactJsonStringPayload } from '../utils/eventPayloadRedaction';

const ANONYMIZED_PLACEHOLDER = '[anonymized]';

export interface AnonymizationStoreSummary {
  playersScrubbed: number;
  profileHistoryDeleted: number;
  pendingMilestonesDeleted: number;
  profileViewsDeleted: number;
  contactUnlocksDeleted: number;
  trialOffersDeleted: number;
  scoutBookmarksDeleted: number;
  scoutPlayerNotesDeleted: number;
  scoutPlayerNotesV2Deleted: number;
  trialOfferEventsDeleted: number;
  eventsPayloadsRedacted: number;
  webhookDeadLettersRedacted: number;
  webhookDeliveriesScrubbed: number;
  idempotencyKeysDeleted: number;
  savedSearchNotificationsDeleted: number;
  auditLogPiiDeleted: number;
}

async function countChanges(result: { changes: number }): Promise<number> {
  return result.changes;
}

// ─── POST /api/players/:playerId/anonymize ──────────────────────────────────

export async function anonymizePlayer(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const idResult = playerIdSchema.safeParse(req.params.playerId as string);
    if (!idResult.success) {
      res.status(400).json({
        success: false,
        error: idResult.error.errors[0]?.message ?? 'Invalid playerId',
        code: ErrorCode.VALIDATION_ERROR,
      });
      return;
    }
    const playerId = req.params.playerId as string;

    const player = await getPlayerById(playerId);
    if (!player) {
      res.status(404).json({
        success: false,
        error: 'Player not found',
        code: ErrorCode.NOT_FOUND,
      });
      return;
    }

    const cidsToUnpin: string[] = [];
    if (player.metadata_uri) cidsToUnpin.push(player.metadata_uri);
    const historyRows = await getPlayerProfileHistory(playerId);
    for (const row of historyRows) {
      if (row.metadata_uri) cidsToUnpin.push(row.metadata_uri);
    }

    const summary: AnonymizationStoreSummary = {
      playersScrubbed: 0,
      profileHistoryDeleted: historyRows.length,
      pendingMilestonesDeleted: 0,
      profileViewsDeleted: 0,
      contactUnlocksDeleted: 0,
      trialOffersDeleted: 0,
      scoutBookmarksDeleted: 0,
      scoutPlayerNotesDeleted: 0,
      scoutPlayerNotesV2Deleted: 0,
      trialOfferEventsDeleted: 0,
      eventsPayloadsRedacted: 0,
      webhookDeadLettersRedacted: 0,
      webhookDeliveriesScrubbed: 0,
      idempotencyKeysDeleted: 0,
      savedSearchNotificationsDeleted: 0,
      auditLogPiiDeleted: 0,
    };

    await getDriver().transaction(async (tx) => {
      summary.playersScrubbed = await countChanges(await tx.run(
        `UPDATE players
         SET wallet = ?,
             position = NULL,
             region = NULL,
             metadata_uri = NULL,
             is_active = 0,
             deactivation_reason = ?
         WHERE player_id = ?`,
        [ANONYMIZED_PLACEHOLDER, 'GDPR anonymization request', playerId],
      ));

      summary.profileHistoryDeleted = await countChanges(await tx.run(
        'DELETE FROM player_profile_history WHERE player_id = ?',
        [playerId],
      ));

      summary.pendingMilestonesDeleted = await countChanges(await tx.run(
        'DELETE FROM pending_milestones WHERE player_id = ?',
        [playerId],
      ));

      summary.profileViewsDeleted = await countChanges(await tx.run(
        'DELETE FROM profile_views WHERE player_id = ?',
        [playerId],
      ));

      summary.contactUnlocksDeleted = await countChanges(await tx.run(
        'DELETE FROM contact_unlocks WHERE player_id = ?',
        [playerId],
      ));

      summary.trialOffersDeleted = await countChanges(await tx.run(
        'DELETE FROM trial_offers WHERE player_id = ?',
        [playerId],
      ));

      summary.scoutBookmarksDeleted = await countChanges(await tx.run(
        'DELETE FROM scout_bookmarks WHERE player_id = ?',
        [playerId],
      ));

      summary.scoutPlayerNotesDeleted = await countChanges(await tx.run(
        'DELETE FROM scout_player_notes WHERE player_id = ?',
        [playerId],
      ));

      summary.scoutPlayerNotesV2Deleted = await countChanges(await tx.run(
        'DELETE FROM scout_player_notes_v2 WHERE player_id = ?',
        [playerId],
      ));

      summary.trialOfferEventsDeleted = await countChanges(await tx.run(
        'DELETE FROM trial_offer_events WHERE player_id = ?',
        [playerId],
      ));

      summary.savedSearchNotificationsDeleted = await countChanges(await tx.run(
        'DELETE FROM saved_search_notifications WHERE player_id = ?',
        [playerId],
      ));

      const playerNeedle = `%${playerId}%`;
      const eventRows = await tx.all<{ id: number; payload: string }>(
        'SELECT id, payload FROM events WHERE payload LIKE ?',
        [playerNeedle],
      );
      for (const row of eventRows) {
        const redacted = redactJsonStringPayload(row.payload, playerId);
        if (redacted === null || redacted === row.payload) continue;
        await tx.run('UPDATE events SET payload = ? WHERE id = ?', [redacted, row.id]);
        summary.eventsPayloadsRedacted += 1;
      }

      const deadLetterRows = await tx.all<{ id: number; payload: string }>(
        'SELECT id, payload FROM webhook_dead_letters WHERE payload LIKE ?',
        [playerNeedle],
      );
      for (const row of deadLetterRows) {
        const redacted = redactJsonStringPayload(row.payload, playerId);
        if (redacted === null || redacted === row.payload) continue;
        await tx.run('UPDATE webhook_dead_letters SET payload = ? WHERE id = ?', [redacted, row.id]);
        summary.webhookDeadLettersRedacted += 1;
      }

      summary.webhookDeliveriesScrubbed = await countChanges(await tx.run(
        `UPDATE webhook_deliveries
         SET error_message = ?
         WHERE error_message LIKE ?`,
        [ANONYMIZED_PLACEHOLDER, playerNeedle],
      ));

      summary.idempotencyKeysDeleted = await countChanges(await tx.run(
        'DELETE FROM idempotency_keys WHERE response LIKE ?',
        [playerNeedle],
      ));

      summary.auditLogPiiDeleted = await countChanges(await tx.run(
        'DELETE FROM audit_log_pii WHERE pii_json LIKE ?',
        [playerNeedle],
      ));
    });

    await invalidatePlayerCache(playerId);
    await invalidateMilestoneCache(playerId);

    const uniqueCids = [...new Set(cidsToUnpin)];
    for (const cid of uniqueCids) {
      try {
        await unpinCid(cid);
      } catch (err) {
        logger.warn('[anonymize] IPFS unpin failed', { cid, error: err instanceof Error ? err.message : String(err) });
      }
    }

    await logAuditEvent({
      action: 'player_anonymized',
      timestamp: new Date().toISOString(),
      queryParams: {
        player_id: playerId,
        cids_unpinned: uniqueCids.length,
        requester: req.account ?? 'unknown',
        store_summary: summary,
      },
    }).catch(() => {});

    logger.info('[anonymize] Player data anonymized', { playerId, cidsUnpinned: uniqueCids.length });

    res.json({
      success: true,
      message: 'Player data has been anonymized. On-chain data is immutable and cannot be erased — see docs/data-privacy.md for details.',
      anonymized: {
        dbFieldsScrubbed: summary.playersScrubbed > 0 || player.wallet === ANONYMIZED_PLACEHOLDER,
        profileHistoryDeleted: summary.profileHistoryDeleted,
        ipfsCidsUnpinned: uniqueCids.length,
        stores: summary,
      },
    });
  } catch (err) {
    next(err);
  }
}
