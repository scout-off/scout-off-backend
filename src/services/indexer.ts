import { server } from './stellar';
import { scValToNative } from '@stellar/stellar-sdk';
import { createId } from '@paralleldrive/cuid2';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import config from '../config';
import {
  getDb,
  getDriver,
  getPlayerByOnChainId,
  getPlayerByWallet,
  fetchLastIndexedLedger,
  persistLastIndexedLedger,
  insertOrUpdatePlayer,
  updatePlayerProgress,
  insertPendingMilestone,
  getEventsCount,
  rollbackEventsFromLedger,
} from '../db';
import { dispatchEventWebhook } from './webhooks';
import { logger } from '../utils/logger';
import { tierForApprovedMilestones } from './tierPromotion';
import {
  normalizeAndSortEvents,
  groupCoTransactionEvents,
  type RawIndexerEvent,
  type NormalizedIndexerEvent,
} from './eventOrdering';
import { withRestoredCorrelation } from './txCorrelation';
import { broadcaster } from './eventBroadcaster';

const tracer = trace.getTracer('scout-off-backend');

// Lazy import cache service to avoid circular dependency
function getCache() {
  return require('./cache');
}

/** Current indexer lag in ledgers (latestChainLedger - lastIndexedLedger). Reset after each poll. */
export let indexerLedgerLag = 0;

// ─── Payload normalisation ────────────────────────────────────────────────────
//
// The Soroban contract emits events with snake_case field names but some events
// arrive with camelCase keys. normalizePayload() converts every camelCase key to
// snake_case on ingest so all DB reads can use a single canonical naming style.

function camelToSnake(key: string): string {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/** Convert every camelCase key in a payload to snake_case. */
export function normalizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(payload).map(([k, v]) => [camelToSnake(k), v])
  );
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]),
    );
  }
  return value;
}

function nativeText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

/** Normalize the register contract's compact topics and positional event data. */
export function normalizeSorobanEvent(raw: {
  topic?: unknown[];
  value?: unknown;
}): { type: string; payload: Record<string, unknown> } {
  const topics = raw.topic ?? [];
  const rawType = topics[0] ? nativeText(scValToNative(topics[0] as never)) : '';
  const typeAliases: Record<string, string> = {
    player_rg: 'player_registered',
    tok_iss: 'token_issued',
    tok_buy: 'token_bought',
    fee_upd: 'platform_fee_updated',
  };
  let type = typeAliases[rawType] ?? rawType;
  const nativeValue = raw.value ? scValToNative(raw.value as never) : undefined;
  const tuple = Array.isArray(nativeValue) ? nativeValue : [];
  let payload: Record<string, unknown>;

  if (rawType === 'player_rg') {
    const onChainPlayerId = nativeText(tuple[0]);
    return {
      type: 'player_registered',
      payload: {
        player_id: onChainPlayerId,
        on_chain_player_id: onChainPlayerId,
        wallet: nativeText(topics[1] ? scValToNative(topics[1] as never) : undefined),
        metadata_uri: nativeText(tuple[1]),
        position: nativeText(tuple[2]),
        region: nativeText(tuple[3]),
      },
    };
  }

  if (nativeValue && typeof nativeValue === 'object' && !Array.isArray(nativeValue)) {
    payload = normalizePayload(jsonSafe(nativeValue) as Record<string, unknown>);
  } else if (Array.isArray(nativeValue)) {
    payload = {};
  } else {
    payload = { data: jsonSafe(nativeValue) };
  }

  if (rawType === 'contact_unlocked' && topics.length === 1 && tuple.length >= 2) {
    payload.scout = nativeText(tuple[0]);
    payload.player_id = nativeText(tuple[1]);
  } else if (rawType === 'contact_unlocked' && topics.length >= 3) {
    type = 'connection_created';
    payload.scout = nativeText(scValToNative(topics[1] as never));
    payload.player_id = nativeText(scValToNative(topics[2] as never));
    if (tuple.length >= 1) payload.connection_type = nativeText(tuple[0]);
  } else if (rawType === 'fee_upd' && tuple.length >= 1) {
    payload.new_bps = tuple[0];
  } else if (rawType === 'tok_iss' && tuple.length >= 1) {
    payload.total_supply = tuple[0];
  } else if (rawType === 'tok_buy' && tuple.length >= 2) {
    payload.buyer = nativeText(tuple[0]);
    payload.amount = tuple[1];
  } else if (type === 'milestone_submitted' && tuple.length >= 3) {
    payload.milestone_id = nativeText(tuple[0]);
    payload.milestone_type = nativeText(tuple[1]);
    payload.evidence_uri = nativeText(tuple[2]);
    if (topics[1]) payload.validator = nativeText(scValToNative(topics[1] as never));
  } else if (type === 'milestone_approved' && tuple.length >= 2) {
    payload.milestone_id = nativeText(tuple[0]);
    payload.new_level = tuple[1];
    if (topics[1]) payload.validator = nativeText(scValToNative(topics[1] as never));
  }

  const playerTopicIndex = rawType.startsWith('tok_')
    || ['token_issued', 'token_bought'].includes(type)
    ? 1
    : ['milestone_submitted', 'milestone_approved', 'milestone_rejected', 'contact_unlocked', 'connection_created', 'connection_closed', 'trial_offer_logged'].includes(type)
      ? 2
      : -1;
  const topicPlayerId = playerTopicIndex >= 0 && topics[playerTopicIndex]
    ? nativeText(scValToNative(topics[playerTopicIndex] as never))
    : '';
  const payloadPlayerId = nativeText(payload.player_id);
  const onChainPlayerId = topicPlayerId || (/^\d+$/.test(payloadPlayerId) ? payloadPlayerId : '');

  if (onChainPlayerId) {
    payload.on_chain_player_id = onChainPlayerId;
    payload.player_id = onChainPlayerId;
  }

  return { type, payload };
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const lastIndexed = fetchLastIndexedLedger();
  const margin = config.indexer.finalityMargin;
  const fromLedger = Math.max(0, lastIndexed > margin ? lastIndexed - margin : 0);
  span.setAttribute('indexer.ledger_start', fromLedger);

  const contractIds = [
    config.contractId,
    config.registerContractId,
    config.progressContractId,
    config.subscriptionContractId,
    config.connectionContractId,
  ].filter((id, i, arr) => Boolean(id) && arr.indexOf(id) === i);

  const response = await server.getEvents({
    startLedger: fromLedger > 0 ? fromLedger : 1,
    filters: [{ type: 'contract', contractIds: contractIds.length ? contractIds : [config.contractId] }],
  });
  span.setAttribute('indexer.ledger_end', response.latestLedger);
  span.setAttribute('indexer.events_processed', response.events.length);

  const lagAfterPoll = Math.max(0, response.latestLedger - (lastIndexed > 0 ? lastIndexed - 1 : response.latestLedger));
  indexerLedgerLag = lagAfterPoll;
  const threshold = config.indexer.lagWarnThreshold;
  if (lagAfterPoll > threshold) {
    logger.warn(`[indexer] ledger lag=${lagAfterPoll} exceeds threshold=${threshold}`);
  }

  if (!response.events.length) return;

  const webhookEvents: Array<{ type: string; payload: unknown; txHash: string }> = [];

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
  const overlappingEvents = db.prepare('SELECT ledger, ledger_hash FROM events WHERE ledger >= ?').all(fromLedger) as { ledger: number, ledger_hash: string | null }[];
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

  const applyOne = async (event: (typeof ordered)[number]): Promise<void> => {
    const raw = event.raw as any;
    const normalized = normalizeSorobanEvent(raw);
    const type = normalized.type;
    const payload = normalized.payload;
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
    if (!eventInserted) return;
    __indexerHooks.afterInsert(eventId);

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
              ].filter(Boolean).join(', ')})`,
            );
          }
          webhookEvents.push({ type, payload, txHash: event.txHash });
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
          webhookEvents.push({ type, payload, txHash: event.txHash });
        }
      },
      span,
    );
  };

  for (const group of groups) {
    // Atomic co-transaction group: apply every event in order before the next tx.
    for (const event of group) {
      await applyOne(event);
      // Broadcast to SSE (in-process + Redis if configured) after successful persistence
      broadcastIndexedEvent(event);
    }
  }

  const latest = ordered.at(-1)!;

  // 3. Update last indexed ledger once the batch above has been applied.
  persistLastIndexedLedger(latest.ledger + 1);

  // 4. Dispatch webhooks for indexed events (milestone_submitted, milestone_approved)
  for (const { type, payload, txHash } of webhookEvents) {
    withRestoredCorrelation(txHash, 'indexer.webhookDispatch', async () => {
      await dispatchEventWebhook(type, payload);
    }, span).catch((err: unknown) => {
      logger.warn(
        `[indexer] webhook dispatch failed for ${type}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  indexerLedgerLag = Math.max(0, response.latestLedger - latest.ledger);
  } catch (err) {
    span.recordException(err as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
    throw err;
  } finally {
    span.end();
  }
  });
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
function broadcastIndexedEvent(event: NormalizedIndexerEvent): void {
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

// ─── Trial offer event log (#285) ──────────────────────────────────────────────

export interface TrialOfferEventRow {
  scout_wallet: string;
  player_id: string;
  details_uri: string;
  tx_hash: string;
  created_at: number;
}

/**
 * Persist an on-chain trial offer submission. Deduped by tx_hash (ON
 * CONFLICT DO NOTHING) so replaying the same on-chain event never creates
 * duplicate rows.
 */
export async function insertTrialOffer(
  scoutWallet: string,
  playerId: string,
  detailsUri: string,
  txHash: string,
  createdAt: number,
): Promise<void> {
  await getDriver().run(
    `INSERT INTO trial_offer_events (scout_wallet, player_id, details_uri, tx_hash, created_at)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT (tx_hash) DO NOTHING`,
    [scoutWallet, playerId, detailsUri, txHash, createdAt],
  );
}

/** Return all trial offer events for a scout wallet, most recent first. */
export async function getTrialOffers(scoutWallet: string): Promise<TrialOfferEventRow[]> {
  return getDriver().all<TrialOfferEventRow>(
    `SELECT scout_wallet, player_id, details_uri, tx_hash, created_at
     FROM trial_offer_events WHERE scout_wallet = ? ORDER BY created_at DESC`,
    [scoutWallet],
  );
}

// ─── Validator registry helpers ───────────────────────────────────────────────

export interface ValidatorRow {
  wallet: string;
  registered_at: number;
  revoked_at: number | null;
  tx_hash: string | null;
}

/**
 * Insert a newly registered validator into the local DB.
 * Uses ON CONFLICT DO UPDATE so a re-registration after revocation resets
 * the row (equivalent to the old INSERT OR REPLACE, but portable — REPLACE
 * is SQLite-only syntax).
 */
export async function insertValidator(wallet: string, txHash?: string): Promise<void> {
  await getDriver().run(
    `INSERT INTO validators (wallet, registered_at, revoked_at, tx_hash)
     VALUES (?, ?, NULL, ?)
     ON CONFLICT (wallet) DO UPDATE SET
       registered_at = excluded.registered_at,
       revoked_at = NULL,
       tx_hash = excluded.tx_hash`,
    [wallet, Math.floor(Date.now() / 1000), txHash ?? null],
  );
}

/**
 * Mark an existing validator as revoked by setting revoked_at.
 * No-op if the wallet is not found.
 */
export async function revokeValidatorRow(wallet: string, txHash?: string): Promise<void> {
  await getDriver().run(
    `UPDATE validators SET revoked_at = ?, tx_hash = ? WHERE wallet = ?`,
    [Math.floor(Date.now() / 1000), txHash ?? null, wallet],
  );
}

/**
 * Return all validator rows ordered by registration time descending.
 */
export async function getAllValidators(): Promise<ValidatorRow[]> {
  return getDriver().all<ValidatorRow>(
    `SELECT wallet, registered_at, revoked_at, tx_hash FROM validators ORDER BY registered_at DESC`,
  );
}

/**
 * Return a single validator row by wallet address, or null if not found.
 */
export async function getValidatorByWallet(wallet: string): Promise<ValidatorRow | null> {
  return (
    (await getDriver().get<ValidatorRow>(
      `SELECT wallet, registered_at, revoked_at, tx_hash FROM validators WHERE wallet = ?`,
      [wallet],
    )) ?? null
  );
}
