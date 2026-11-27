/**
 * indexer/dispatch.ts
 *
 * Outbound delivery for indexed events (split out of services/indexer.ts).
 *
 * Two independent fan-outs live here, both triggered only after an event has
 * been persisted:
 *   - `broadcastIndexedEvent` pushes the event to in-process SSE subscribers
 *     (and Redis, when configured) via the event broadcaster.
 *   - `dispatchIndexerWebhooks` delivers the events that have registered
 *     webhooks (milestone_submitted / milestone_approved).
 *
 * Neither touches the database; failures are logged and never abort a batch.
 */

import { scValToNative } from '@stellar/stellar-sdk';
import type { Span } from '@opentelemetry/api';
import { normalizePayload } from './decode';
import { dispatchEventWebhook } from '../webhooks';
import { broadcaster } from '../eventBroadcaster';
import { withRestoredCorrelation } from '../txCorrelation';
import { logger } from '../../utils/logger';
import type { NormalizedIndexerEvent } from '../eventOrdering';

/** An indexed event queued for webhook delivery. */
export interface WebhookEvent {
  type: string;
  payload: unknown;
  txHash: string;
  ledger: number;
}

// ─── SSE broadcasting for indexed events ──────────────────────────────────────

/**
 * Track events that should be broadcast to SSE clients.
 * The indexer broadcasts only for newly inserted rows to avoid double delivery
 * when both a controller (e.g., scoutController) and the indexer emit the same
 * logical event. Controllers are responsible for broadcasting their own events;
 * the indexer only broadcasts events it persisted.
 *
 * Deduplication strategy:
 *   - The indexer broadcasts AFTER successful INSERT OR IGNORE (row counts as new).
 *   - Controllers broadcast when they successfully submit a transaction.
 *   - When a controller's transaction is also indexed, the indexer's broadcast
 *     is skipped (dedupe by tx_hash) — handled by the indexer not broadcasting
 *     to already-persisted events.
 *
 * Event types broadcast by the indexer (from contract events):
 *   - player_registered      (after insertOrUpdatePlayer succeeds)
 *   - milestone_submitted    (after insertPendingMilestone succeeds)
 *   - milestone_approved     (after updatePlayerProgress succeeds)
 *   - scout_subscribed       (after insertSubscription)
 *   - contact_unlocked       (after insertContactUnlock)
 *   - trial_offer_logged     (after insertTrialOffer)
 *   - fees_withdrawn         (via admin webhook, not indexer)
 */
export function broadcastIndexedEvent(event: NormalizedIndexerEvent): void {
  const raw = event.raw as any;
  const type = raw.topic?.[0] ? (scValToNative(raw.topic[0]) as string) : '';
  const payload = normalizePayload(
    (raw.value ? (scValToNative(raw.value) as Record<string, unknown>) : {}) ?? {},
  );
  const txHash = event.txHash;

  // Determine if this event was newly inserted (dedupe by tx_hash)
  // For now, we broadcast all events from the indexer after successful indexing.
  // In a future enhancement, we could track which tx_hashes we've already
  // broadcast and skip those to avoid double delivery.

  // Only broadcast events we actually indexed (not from our own broadcast)
  switch (type) {
    case 'player_registered':
      broadcaster.broadcast({
        type: 'player_registered',
        payload: {
          player_id: payload.player_id,
          wallet: payload.wallet,
          position: payload.position,
          region: payload.region,
          metadata_uri: payload.metadata_uri,
          tx_hash: txHash,
          timestamp: new Date().toISOString(),
        },
      });
      break;
    case 'milestone_submitted':
      broadcaster.broadcast({
        type: 'milestone_submitted',
        payload: {
          milestone_id: payload.milestone_id,
          player_id: payload.player_id,
          validator: payload.validator,
          milestone_type: payload.milestone_type,
          evidence_uri: payload.evidence_uri,
          tx_hash: txHash,
          timestamp: new Date().toISOString(),
        },
      });
      break;
    case 'milestone_approved':
      broadcaster.broadcast({
        type: 'milestone_approved',
        payload: {
          player_id: payload.player_id,
          milestone_id: payload.milestone_id,
          tx_hash: txHash,
          timestamp: new Date().toISOString(),
        },
      });
      break;
    case 'scout_subscribed':
      broadcaster.broadcast({
        type: 'scout_subscribed',
        payload: {
          scout: payload.scout,
          tier: payload.tier,
          expires_at: payload.subscription_expiry,
          tx_hash: txHash,
          timestamp: new Date().toISOString(),
        },
      });
      break;
    case 'contact_unlocked':
      broadcaster.broadcast({
        type: 'contact_unlocked',
        payload: {
          scout: payload.scout,
          player_id: payload.player_id,
          tx_hash: txHash,
          timestamp: new Date().toISOString(),
        },
      });
      break;
    case 'trial_offer_logged':
      broadcaster.broadcast({
        type: 'trial_offer_logged',
        payload: {
          scout: payload.scout,
          player_id: payload.player_id,
          details_uri: payload.details_uri,
          tx_hash: txHash,
          timestamp: new Date().toISOString(),
        },
      });
      break;
  }
}

// ─── Webhook dispatch ─────────────────────────────────────────────────────────

/**
 * Deliver the collected webhook events, each inside its own restored-correlation
 * span so a webhook failure is traced back to the originating transaction.
 * A failing delivery is logged and swallowed — it must never abort the batch.
 */
export async function dispatchIndexerWebhooks(
  webhookEvents: WebhookEvent[],
  span: Span,
): Promise<void> {
  await Promise.all(webhookEvents.map(({ type, payload, txHash, ledger }) =>
    withRestoredCorrelation(txHash, 'indexer.webhookDispatch', async () => {
      await dispatchEventWebhook(type, payload);
    }, span, { 'stellar.ledger': ledger, 'scoutoff.event_type': type }).catch((err: unknown) => {
      logger.warn(
        `[indexer] webhook dispatch failed for ${type}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }),
  ));
}
