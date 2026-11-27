/**
 * indexer/apply.ts
 *
 * Database application of fetched contract events (split out of
 * services/indexer.ts).
 *
 * Owns the indexer pipeline tail:
 *   - Reorg detection against the persisted events table.
 *   - Deterministic ordering (#1111) and co-transaction atomic application.
 *   - Per-event decoding via ./decode, outcome classification (#1540,
 *     `applied` / `unknown_type` / `decode_error`) and persistence of events
 *     the indexer could not apply (`indexer_unprocessed_events`).
 *   - Cursor persistence, including holding the cursor when a *known* event
 *     fails to decode.
 *   - Replay of parked events once the decoder is fixed.
 *
 * SSE broadcast + webhook fan-out live in ./dispatch; RPC polling in ./fetch;
 * the mutable lag/counter state read by src/app.ts in ./state.
 */

import { createId } from '@paralleldrive/cuid2';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../../config';
import {
  getDb,
  getPlayerByOnChainId,
  getPlayerByWallet,
  fetchLastIndexedLedger,
  persistLastIndexedLedger,
  insertOrUpdatePlayer,
  updatePlayerProgress,
  insertPendingMilestone,
  getEventsCount,
  rollbackEventsFromLedger,
  insertUnprocessedEvent,
  getUnprocessedEventById,
  deleteUnprocessedEvent,
} from '../../db';
import { logger } from '../../utils/logger';
import { recordIndexerEvent, IndexerEventOutcome } from '../../middleware/metrics';
import { tierForApprovedMilestones } from '../tierPromotion';
import {
  normalizeAndSortEvents,
  groupCoTransactionEvents,
  type RawIndexerEvent,
} from '../eventOrdering';
import { withRestoredCorrelation } from '../txCorrelation';
import {
  normalizeSorobanEvent,
  isKnownEventType,
  safeTopicType,
  serializeEventForReplay,
  deserializeEventFromReplay,
} from './decode';
import { fetchIndexerEvents } from './fetch';
import { broadcastIndexedEvent, dispatchIndexerWebhooks, type WebhookEvent } from './dispatch';
import { setIndexerLedgerLag, markIndexerSuccess, incrementIndexerPollFailures } from './state';

const tracer = trace.getTracer('scout-off-backend');

// Lazy import cache service to avoid circular dependency
function getCache() {
  return require('../cache');
}

/**
 * Persist an event the indexer could not apply, with enough raw data to replay
 * it, and emit a structured warning carrying ledger/tx/contract/topic context.
 */
async function recordUnappliedEvent(params: {
  event: { ledger: number; txHash: string; eventIndex: number; contractId: string; raw: unknown };
  type: string | null;
  outcome: IndexerEventOutcome;
  detail: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const { event, type, outcome, detail } = params;
  const raw = event.raw as { topic?: unknown[]; value?: unknown };
  const { topicJson, valueXdr } = serializeEventForReplay(raw);

  logger.warn(
    {
      outcome,
      type: type ?? safeTopicType(raw),
      ledger: event.ledger,
      tx_hash: event.txHash,
      event_index: event.eventIndex,
      contract_id: event.contractId,
      topic: topicJson,
      detail,
    },
    '[indexer] event not applied',
  );

  try {
    await insertUnprocessedEvent({
      type,
      ledger: event.ledger,
      tx_hash: event.txHash,
      event_index: event.eventIndex,
      contract_id: event.contractId,
      topic_json: topicJson,
      value_xdr: valueXdr,
      reason: outcome,
      payload: params.payload ? JSON.stringify(params.payload) : null,
    });
  } catch (err) {
    // Never let the unprocessed-events write take down the batch — the metric
    // and warning above already surfaced the problem.
    logger.error(
      { err, tx_hash: event.txHash, event_index: event.eventIndex },
      '[indexer] failed to persist unprocessed event',
    );
  }
}

// ─── Deduplication strategy ───────────────────────────────────────────────────
//
// Primary deduplication: UNIQUE(tx_hash, event_index) — co-transaction events
// are retained; replays of the same (tx, index) are ignored.
//
// Canonical event ID: each event is identified by the tuple
//   (contractId, ledger, txHash, eventIndex)
// normalizeEventId() encodes this as a single opaque string.
//
// Total order (#1111): events are sorted by
//   (ledger, tx_application_order, event_index, contract_id)
// before insert and side-effect application. Co-transaction groups are applied
// atomically (all inserts + side effects for one tx before the next tx).

/**
 * Returns a canonical, stable ID for a contract event.
 * Format: `<contractId>:<ledger>:<txHash>:<eventIndex>`
 */
export function normalizeEventId(
  contractId: string,
  ledger: number,
  txHash: string,
  eventIndex = 0,
): string {
  return `${contractId}:${ledger}:${txHash}:${eventIndex}`;
}

/**
 * Indexer event hooks for test fault injection and observability.
 *
 * Usage (tests only):
 *   import { __indexerHooks } from './indexer';
 *   __indexerHooks.beforeInsert = (eventId) => {
 *     if (shouldSimulateFailure) throw new Error('simulated crash');
 *   };
 *
 * These hooks are called around every event insert to enable:
 * - Fault injection (e.g., crash between insert and side effects)
 * - Idempotent reprocessing verification
 * - Metrics / alerting (future)
 *
 * @internal Test-only API; do not use in production.
 */
export const __indexerHooks = {
  beforeInsert: (_eventId: string) => {},
  afterInsert: (_eventId: string) => {},
};

// ─── Indexer ──────────────────────────────────────────────────────────────────

export async function indexEvents(): Promise<void> {
  return tracer.startActiveSpan('indexer.poll', async (span) => {
    try {
      const db = getDb();
      const insert = db.prepare(
        `INSERT OR IGNORE INTO events
      (type, ledger, ledger_hash, tx_hash, payload, created_at,
       tx_application_order, event_index, contract_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      const lastIndexed = fetchLastIndexedLedger();
      const margin = config.indexer.finalityMargin;
      const fromLedger = Math.max(0, lastIndexed > margin ? lastIndexed - margin : 0);
      span.setAttribute('indexer.ledger_start', fromLedger);

      const response = await fetchIndexerEvents(fromLedger);
      span.setAttribute('indexer.ledger_end', response.latestLedger);
      span.setAttribute('indexer.events_processed', response.events.length);

      const lagAfterPoll = Math.max(
        0,
        response.latestLedger - (lastIndexed > 0 ? lastIndexed - 1 : response.latestLedger),
      );
      setIndexerLedgerLag(lagAfterPoll);
      const threshold = config.indexer.lagWarnThreshold;
      if (lagAfterPoll > threshold) {
        logger.warn(`[indexer] ledger lag=${lagAfterPoll} exceeds threshold=${threshold}`);
      }

      if (!response.events.length) {
        markIndexerSuccess();
        return;
      }

      const webhookEvents: WebhookEvent[] = [];

      // NOTE: this used to be (and, on main, still is) a single synchronous
      // db.transaction() wrapping the whole batch, including reorg detection.
      // insertOrUpdatePlayer/insertPendingMilestone/updatePlayerProgress now go
      // through the async DbDriver (required to support DB_DRIVER=postgres), so
      // they can no longer run inside a synchronous better-sqlite3 transaction
      // callback — reorg detection and the events-table insert itself (both
      // owned by the event-indexing subsystem) still go through the raw
      // synchronous getDb() handle unchanged, but player/milestone upserts run
      // as a separate async loop below rather than inside one atomic
      // transaction. Losing whole-batch atomicity here is safe: every insert
      // below is idempotent (events dedup on (tx_hash, event_index) via
      // INSERT OR IGNORE, player/milestone upserts are keyed and re-appliable),
      // so a mid-batch failure just gets safely reprocessed on the next poll
      // from the same fromLedger.
      //
      // Co-transaction atomicity (#1111): within a single transaction's event
      // group we still apply inserts + side effects sequentially before moving
      // to the next transaction so order-sensitive consumers never see a later
      // sibling before an earlier one.

      // 1. Reorg detection
      const overlappingEvents = db
        .prepare('SELECT ledger, ledger_hash FROM events WHERE ledger >= ?')
        .all(fromLedger) as { ledger: number; ledger_hash: string | null }[];
      const existingHashes = new Map<number, string>();
      for (const row of overlappingEvents) {
        if (row.ledger_hash) existingHashes.set(row.ledger, row.ledger_hash);
      }

      let reorgLedger: number | null = null;
      for (const raw of response.events) {
        const existingHash = existingHashes.get(raw.ledger);
        const incomingHash = (raw as any).ledgerHash ?? (raw as any).pagingToken ?? raw.txHash;
        if (existingHash && incomingHash && existingHash !== incomingHash) {
          reorgLedger = raw.ledger;
          break;
        }
      }

      if (reorgLedger !== null) {
        logger.warn(`[indexer] Reorg detected at ledger ${reorgLedger}! Rolling back...`);
        rollbackEventsFromLedger(reorgLedger);
      }

      // 2. Normalize + sort into deterministic total order, then apply as
      //    co-transaction atomic groups regardless of RPC return order.
      const rawEvents: RawIndexerEvent[] = response.events.map((raw: any) => ({
        ledger: raw.ledger,
        txHash: raw.txHash,
        id: raw.id,
        contractId: raw.contractId ?? config.contractId,
        topic: raw.topic,
        value: raw.value,
        ledgerClosedAt: raw.ledgerClosedAt,
        ledgerHash: raw.ledgerHash,
        pagingToken: raw.pagingToken,
        txIndex: raw.txIndex,
        eventIndex: raw.eventIndex,
      }));

      const ordered = normalizeAndSortEvents(rawEvents, config.contractId);
      const groups = groupCoTransactionEvents(ordered);

      const applyOne = async (event: (typeof ordered)[number]): Promise<IndexerEventOutcome> => {
        const raw = event.raw as any;

        // 1. Decode. A throw here means the value shape is unexpected (e.g. a
        //    contract upgrade reshaped the event) — classify as decode_error,
        //    count it, log it, and park it for replay rather than aborting the
        //    batch.
        let normalized: { type: string; payload: Record<string, unknown> };
        try {
          normalized = normalizeSorobanEvent(raw);
        } catch (err) {
          recordIndexerEvent(safeTopicType(raw) || 'unknown', 'decode_error');
          await recordUnappliedEvent({
            event,
            type: safeTopicType(raw) || null,
            outcome: 'decode_error',
            detail: err instanceof Error ? err.message : String(err),
          });
          return 'decode_error';
        }

        const type = normalized.type;
        const payload = normalized.payload;
        const outcome: IndexerEventOutcome = isKnownEventType(type) ? 'applied' : 'unknown_type';

        // 2. Recognise the type. Anything outside the CONTRACT_EVENT_TYPES
        //    allowlist is an unknown_type: counted, logged, and parked for replay.
        //    The raw event row is still inserted below so it is not lost.
        if (outcome === 'unknown_type') {
          recordIndexerEvent(type, 'unknown_type');
          await recordUnappliedEvent({
            event,
            type,
            outcome: 'unknown_type',
            detail: `unrecognised event type '${type}'`,
            payload,
          });
          // Fall through to insert the raw event row (so it is queryable) but
          // skip type-specific side effects — we do not know how to apply it.
        }

        const onChainPlayerId = payload.on_chain_player_id as string | undefined;
        if (type === 'player_registered' && onChainPlayerId && payload.wallet) {
          const existingPlayer = await getPlayerByWallet(String(payload.wallet));
          payload.player_id = existingPlayer?.player_id ?? createId();
        } else if (onChainPlayerId) {
          const existingPlayer = await getPlayerByOnChainId(onChainPlayerId);
          if (existingPlayer) payload.player_id = existingPlayer.player_id;
        }
        const eventId = normalizeEventId(
          event.contractId,
          event.ledger,
          event.txHash,
          event.eventIndex,
        );
        const createdAt = raw.ledgerClosedAt ? new Date(raw.ledgerClosedAt).getTime() : Date.now();
        const ledgerHash = raw.ledgerHash ?? raw.pagingToken ?? raw.txHash;

        __indexerHooks.beforeInsert(eventId);
        const insertResult = insert.run(
          type,
          event.ledger,
          ledgerHash,
          event.txHash,
          JSON.stringify(payload),
          createdAt,
          event.txApplicationOrder,
          event.eventIndex,
          event.contractId,
        );
        const eventInserted = insertResult.changes > 0;
        if (!eventInserted) return outcome;
        __indexerHooks.afterInsert(eventId);

        // Known events are counted as applied once the raw row is persisted; the
        // type-specific side effects run below. Unknown events were already counted
        // as unknown_type above and skip side effects entirely.
        if (outcome === 'applied') {
          recordIndexerEvent(type, 'applied');
        } else {
          return outcome;
        }

        await withRestoredCorrelation(
          event.txHash,
          'indexer.applyEvent',
          async (correlationId) => {
            if (correlationId) {
              logger.debug(
                `[indexer] restored correlationId=${correlationId} for tx=${event.txHash}`,
              );
            }

            if (type === 'player_registered') {
              const playerId = payload.player_id as string;
              const onChainPlayerId = payload.on_chain_player_id as string | undefined;
              const registeredAt = raw.ledgerClosedAt
                ? new Date(raw.ledgerClosedAt).getTime()
                : Date.now();
              await insertOrUpdatePlayer({
                player_id: playerId,
                on_chain_player_id: onChainPlayerId,
                wallet: payload.wallet as string,
                position: payload.position as string | undefined,
                region: payload.region as string | undefined,
                metadata_uri: payload.metadata_uri as string | undefined,
                created_at: registeredAt,
                registered_at: registeredAt,
              });
              const cache = getCache();
              cache.invalidatePlayerCache(playerId);
            } else if (type === 'milestone_submitted') {
              const milestoneId = payload.milestone_id as string;
              const playerId = payload.player_id as string;
              const validatorWallet = payload.validator as string;
              const milestoneType = payload.milestone_type as string;
              const evidenceUri = payload.evidence_uri as string;
              const submittedAt = raw.ledger;
              // milestone_type / evidence_uri back non-nullable columns, so a
              // malformed on-chain event that omits either is skipped (logged)
              // rather than allowed to abort the whole batch with a constraint
              // error — the raw event row is still recorded above.
              if (milestoneId && playerId && validatorWallet && milestoneType && evidenceUri) {
                await insertPendingMilestone(
                  milestoneId,
                  playerId,
                  validatorWallet,
                  milestoneType,
                  evidenceUri,
                  submittedAt,
                );
              } else {
                logger.warn(
                  `[indexer] skipping malformed milestone_submitted event tx=${event.txHash} ` +
                    `(missing ${[
                      !milestoneId && 'milestone_id',
                      !playerId && 'player_id',
                      !validatorWallet && 'validator',
                      !milestoneType && 'milestone_type',
                      !evidenceUri && 'evidence_uri',
                    ]
                      .filter(Boolean)
                      .join(', ')})`,
                );
              }
              webhookEvents.push({ type, payload, txHash: event.txHash, ledger: event.ledger });
            } else if (type === 'milestone_approved') {
              const playerId = payload.player_id as string;
              if (playerId) {
                const approvedMilestoneCount = getEventsCount('milestone_approved', {
                  payloadFilter: { player_id: playerId },
                });
                await updatePlayerProgress(
                  playerId,
                  tierForApprovedMilestones(approvedMilestoneCount),
                );
                const cache = getCache();
                cache.invalidatePlayerCache(playerId);
              }
              webhookEvents.push({ type, payload, txHash: event.txHash, ledger: event.ledger });
            }
          },
          span,
          { 'stellar.ledger': event.ledger, 'scoutoff.event_type': type },
        );

        return outcome;
      };

      // Track the ledger of the earliest KNOWN event that failed to apply (a
      // decode_error on a recognised type). The cursor must not advance past such
      // an event, so the next poll retries it — see docs/indexer.md.
      let earliestKnownFailureLedger: number | null = null;

      for (const group of groups) {
        // Atomic co-transaction group: apply every event in order before the next tx.
        for (const event of group) {
          let outcome: IndexerEventOutcome;
          try {
            outcome = await applyOne(event);
          } catch (err) {
            // A genuine infrastructure failure (DB down, etc.) on a known event:
            // surface it, hold the cursor at this ledger, and rethrow so the whole
            // batch is retried on the next poll.
            span.recordException(err as Error);
            logger.error(
              { err, tx_hash: event.txHash, ledger: event.ledger },
              '[indexer] failed to apply known event',
            );
            if (earliestKnownFailureLedger === null || event.ledger < earliestKnownFailureLedger) {
              earliestKnownFailureLedger = event.ledger;
            }
            throw err;
          }
          // A decode_error on a recognised (known) type holds the cursor so the
          // event is retried; unknown_type and decode_error on unknown types do
          // not — they are parked in indexer_unprocessed_events for replay.
          if (
            outcome === 'decode_error' &&
            isKnownEventType(safeTopicType(event.raw as { topic?: unknown[] }) || '')
          ) {
            if (earliestKnownFailureLedger === null || event.ledger < earliestKnownFailureLedger) {
              earliestKnownFailureLedger = event.ledger;
            }
          }
          // Broadcast to SSE (in-process + Redis if configured) after successful
          // persistence. Only applied events are broadcast — an unknown or
          // undecodable event has no reliable type/payload to send, and
          // broadcastIndexedEvent re-decodes the raw value (which would throw for
          // a decode_error). Guard it so a broadcast failure never blocks the
          // rest of the batch.
          if (outcome === 'applied') {
            try {
              await withRestoredCorrelation(
                event.txHash,
                'indexer.sseDispatch',
                async () => {
                  broadcastIndexedEvent(event);
                },
                span,
                {
                  'stellar.ledger': event.ledger,
                  'scoutoff.event_type': normalizeSorobanEvent(event.raw).type,
                },
              );
            } catch (err) {
              logger.warn(
                { err, tx_hash: event.txHash },
                '[indexer] SSE broadcast failed for applied event',
              );
            }
          }
        }
      }

      const latest = ordered.at(-1)!;

      // 3. Update last indexed ledger once the batch above has been applied.
      //    If a recognised (known) event failed to decode, do NOT advance the
      //    cursor past it — hold it at that ledger so the next poll retries the
      //    event (e.g. after a decoder fix). Unknown/undecodable events on
      //    unrecognised types do not hold the cursor; they are parked in
      //    indexer_unprocessed_events for replay via the admin endpoint.
      if (earliestKnownFailureLedger !== null) {
        logger.warn(
          { ledger: earliestKnownFailureLedger },
          '[indexer] holding cursor at known event that failed to decode',
        );
        persistLastIndexedLedger(earliestKnownFailureLedger);
      } else {
        persistLastIndexedLedger(latest.ledger + 1);
      }

      // 4. Dispatch webhooks for indexed events (milestone_submitted, milestone_approved)
      await dispatchIndexerWebhooks(webhookEvents, span);

      setIndexerLedgerLag(Math.max(0, response.latestLedger - latest.ledger));
      markIndexerSuccess();
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      incrementIndexerPollFailures();
      throw err;
    } finally {
      span.end();
    }
  });
}

// ─── Replay of unprocessed events (#1540) ───────────────────────────────────

/**
 * Attempt to replay a stored unprocessed event (by id) through the normal
 * apply path once the decoder has been fixed. Rebuilds the raw { topic, value }
 * from persisted XDR, re-normalizes, and — if the type is now recognised —
 * inserts the event row and runs its side effects. On success the unprocessed
 * row is deleted; on failure it is kept (and the reason refreshed).
 *
 * Returns the classification so the admin endpoint can report the outcome.
 */
export async function replayUnprocessedEvent(
  id: number,
): Promise<{ status: 'applied' | 'still_failing' | 'not_found'; detail?: string }> {
  const row = await getUnprocessedEventById(id);
  if (!row) return { status: 'not_found' };

  const rebuilt = deserializeEventFromReplay(row.topic_json, row.value_xdr);
  const raw: { topic?: unknown[]; value?: unknown } = {
    ...(rebuilt.topic ? { topic: rebuilt.topic } : {}),
    ...(rebuilt.value ? { value: rebuilt.value } : {}),
  };

  let normalized: { type: string; payload: Record<string, unknown> };
  try {
    normalized = normalizeSorobanEvent(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(
      { id, tx_hash: row.tx_hash, detail },
      '[indexer] replay still fails to decode unprocessed event',
    );
    return { status: 'still_failing', detail };
  }

  const type = normalized.type;
  const payload = normalized.payload;
  if (!isKnownEventType(type)) {
    const detail = `event type '${type}' is still not recognised`;
    logger.warn({ id, type, tx_hash: row.tx_hash }, `[indexer] ${detail}`);
    return { status: 'still_failing', detail };
  }

  // Resolve the player mapping the same way the live path does.
  const onChainPlayerId = payload.on_chain_player_id as string | undefined;
  if (type === 'player_registered' && onChainPlayerId && payload.wallet) {
    const existingPlayer = await getPlayerByWallet(String(payload.wallet));
    payload.player_id = existingPlayer?.player_id ?? createId();
  } else if (onChainPlayerId) {
    const existingPlayer = await getPlayerByOnChainId(onChainPlayerId);
    if (existingPlayer) payload.player_id = existingPlayer.player_id;
  }

  const db = getDb();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO events
      (type, ledger, ledger_hash, tx_hash, payload, created_at,
       tx_application_order, event_index, contract_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const createdAt = Date.now();
  const ledgerHash = row.tx_hash;
  const insertResult = insert.run(
    type,
    row.ledger ?? 0,
    ledgerHash,
    row.tx_hash,
    JSON.stringify(payload),
    createdAt,
    0,
    row.event_index,
    row.contract_id ?? '',
  );

  // Run side effects for the types that have them (mirrors applyOne).
  if (type === 'player_registered' && payload.player_id) {
    await insertOrUpdatePlayer({
      player_id: payload.player_id as string,
      on_chain_player_id: onChainPlayerId,
      wallet: payload.wallet as string,
      position: payload.position as string | undefined,
      region: payload.region as string | undefined,
      metadata_uri: payload.metadata_uri as string | undefined,
      created_at: createdAt,
      registered_at: createdAt,
    });
    getCache().invalidatePlayerCache(payload.player_id as string);
  } else if (type === 'milestone_submitted') {
    const milestoneId = payload.milestone_id as string;
    const playerId = payload.player_id as string;
    const validatorWallet = payload.validator as string;
    const milestoneType = payload.milestone_type as string;
    const evidenceUri = payload.evidence_uri as string;
    if (milestoneId && playerId && validatorWallet && milestoneType && evidenceUri) {
      await insertPendingMilestone(
        milestoneId,
        playerId,
        validatorWallet,
        milestoneType,
        evidenceUri,
        row.ledger ?? 0,
      );
    }
  } else if (type === 'milestone_approved') {
    const playerId = payload.player_id as string;
    if (playerId) {
      const approvedMilestoneCount = getEventsCount('milestone_approved', {
        payloadFilter: { player_id: playerId },
      });
      await updatePlayerProgress(playerId, tierForApprovedMilestones(approvedMilestoneCount));
      getCache().invalidatePlayerCache(playerId);
    }
  }

  // Only clear the unprocessed row once the event has been applied.
  await deleteUnprocessedEvent(id);
  recordIndexerEvent(type, 'applied');
  logger.info(
    { id, type, tx_hash: row.tx_hash, inserted: insertResult.changes > 0 },
    '[indexer] replayed unprocessed event',
  );
  return { status: 'applied' };
}
