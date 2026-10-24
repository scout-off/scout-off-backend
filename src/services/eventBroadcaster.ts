import { EventEmitter } from 'events';
import { ContractEventType } from '../types';
import { logger } from '../utils/logger';
import { getRedisSubscriberClient, publishSseEvent, subscribeSseEvents } from './redis';
import config from '../config';
import { isEventRelevantToWallet } from './webhookRelevance';

export { isEventRelevantToWallet };

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single broadcast-ready event payload sent over SSE. */
export interface BroadcastEvent {
  type: ContractEventType;
  payload: Record<string, unknown>;
}

/**
 * Optional server-side filter criteria attached to each SSE connection.
 * - `eventTypes`: if non-empty, only events whose `type` is in this set are delivered.
 * - `playerId`  : if provided, only events whose payload contains that player ID are delivered.
 *
 * A subscriber with neither filter set (both defaults) receives every event that
 * passes the wallet-relevance check — preserving the existing wildcard behaviour.
 */
export interface SseFilterCriteria {
  /** Set of event types to receive. Empty set = no type filter (receive all types). */
  eventTypes: ReadonlySet<ContractEventType>;
  /** If set, only events whose payload contains this player ID are delivered. */
  playerId?: string;
}

/**
 * A connected SSE subscriber.
 * The `wallet` is the authenticated Stellar address; `send` pushes a serialised
 * SSE frame to the underlying HTTP response stream.
 */
export interface SseSubscriber {
  wallet: string;
  /** Cuid2 player identity associated with this authenticated wallet, if any. */
  playerId?: string;
  /** Optional server-side filter criteria for this connection. */
  filter?: SseFilterCriteria;
  send: (event: BroadcastEvent) => void;
}

// ─── Relevance filter ─────────────────────────────────────────────────────────
//
// Determines whether a broadcast event is relevant to a given wallet.
// Rules (no cross-tenant leakage):
//
//   milestone_approved  → relevant when payload.player_id matches the
//                         subscriber's associated player ID, or a wallet field
//                         in the payload matches the subscriber wallet.
//
//   scout_subscribed    → relevant when payload.scout (scout wallet) matches.
//   contact_unlocked    → relevant when payload.scout (scout wallet) matches.
//   trial_offer_logged  → relevant when payload.scout matches (scout) or
//                         payload.player_id matches the subscriber's player ID.
//   player_registered   → relevant when payload.wallet matches or the player ID
//                         matches the subscriber's player ID.
//   milestone_submitted → relevant when payload.player_id matches the
//                         subscriber's player ID or payload.validator matches.
//   fees_withdrawn      → relevant when payload.recipient matches (admin).
//
// In practice clients only need milestone_approved, scout_subscribed, and
// contact_unlocked for the described use-cases, but we handle all event types
// so the stream is self-documenting and future-proof.

export function isEventMatchingFilter(
  event: BroadcastEvent,
  filter: SseFilterCriteria | undefined,
): boolean {
  if (!filter) return true;

  // Type filter
  if (filter.eventTypes.size > 0 && !filter.eventTypes.has(event.type)) {
    return false;
  }

  // Player ID filter — look for the player identity in the payload
  if (filter.playerId !== undefined) {
    const p = event.payload;
    const playerInPayload =
      p.player_id === filter.playerId ||
      p.wallet === filter.playerId ||
      p.scout === filter.playerId ||
      p.recipient === filter.playerId ||
      p.validator === filter.playerId;

    if (!playerInPayload) return false;
  }

  return true;
}

// ─── Metrics helpers ──────────────────────────────────────────────────────────

let metrics = {
  published: 0,
  received: 0,
  localBroadcasts: 0,
  redisBroadcasts: 0,
};

/** Reset metrics — only for tests. */
export function _resetMetrics(): void {
  metrics = { published: 0, received: 0, localBroadcasts: 0, redisBroadcasts: 0 };
}

/** Return current metrics. */
export function _getMetrics(): typeof metrics {
  return { ...metrics };
}

// ─── Instance identification ──────────────────────────────────────────────────

/**
 * Unique ID for this process instance.
 * Used to avoid echoing back our own Redis publishes.
 */
const INSTANCE_ID = `${config.redisUrl ? 'redis:' : 'local:'}${Math.random().toString(36).slice(2, 10)}`;

// ─── EventBroadcaster ────────────────────────────────────────────────────────

/**
 * Singleton in-process pub/sub bus for SSE with Redis cross-instance
 * message transport.
 *
 * - When Redis is configured, each broadcast is published to Redis (PUBLISH)
 *   and each instance subscribes (SUBSCRIBE) to events from other instances.
 * - Events from the same origin are skipped to avoid double delivery.
 * - When Redis is NOT configured, the behavior equals the original single-instance
 *   mode: only local broadcasts to in-process subscribers.
 *
 * The indexer calls `broadcast(event)` after persisting each batch of events.
 * The SSE route handler calls `subscribe(subscriber)` on connection and
 * `unsubscribe(subscriber)` on disconnect.
 *
 * Thread-safety note: Node.js is single-threaded; no locking is required.
 */
export class EventBroadcaster extends EventEmitter {
  private static _instance: EventBroadcaster | null = null;

  /** The internal EventEmitter channel name. */
  private static readonly CHANNEL = 'contract_event';

  /** Active subscriber list — used for connection-count metrics. */
  private _subscribers: Set<SseSubscriber> = new Set();

  /** Optional Redis unsubscribe function if Redis is configured. */
  private _redisUnsubscribe?: () => void;

  private constructor() {
    super();
    // Raise the default max-listeners cap: each SSE connection adds one
    // listener, so we expect O(connections) listeners on the emitter.
    this.setMaxListeners(0);
  }

  /** Return (or lazily create) the process-wide singleton. */
  static getInstance(): EventBroadcaster {
    if (!EventBroadcaster._instance) {
      const instance = new EventBroadcaster();
      instance._setupRedis();
      EventBroadcaster._instance = instance;
    }
    return EventBroadcaster._instance;
  }

  /**
   * Reset the singleton — only intended for use in tests to get a clean
   * instance between test cases.
   */
  static _resetForTests(): void {
    if (EventBroadcaster._instance) {
      EventBroadcaster._instance.removeAllListeners();
      EventBroadcaster._instance = null;
    }
  }

  /** Number of currently connected SSE subscribers. */
  get subscriberCount(): number {
    return this._subscribers.size;
  }

  /** Number of currently connected subscribers authenticated as this wallet. */
  getSubscriberCountForWallet(wallet: string): number {
    let count = 0;
    for (const subscriber of this._subscribers) {
      if (subscriber.wallet === wallet) count += 1;
    }
    return count;
  }

  /**
   * Set up Redis pub/sub if configured.
   * Reads from the singleton instance to avoid circular dependency.
   */
  private _setupRedis(): void {
    if (!config.redisUrl) {
      logger.info('[eventBroadcaster] Redis not configured; using in-process-only mode');
      return;
    }

    const subscriber = getRedisSubscriberClient();
    if (!subscriber) {
      logger.warn('[eventBroadcaster] Redis subscriber unavailable; using in-process-only mode');
      return;
    }

    // Subscribe to SSE events from other instances
    this._redisUnsubscribe = subscribeSseEvents((data: unknown) => {
      const msg = data as { type: string; payload: Record<string, unknown>; origin: string };
      metrics.received++;
      
      // Skip events from our own origin (avoid echo)
      if (msg.origin === INSTANCE_ID) {
        return;
      }
      
      // Local broadcast to subscribers
      metrics.localBroadcasts++;
      this.emit(EventBroadcaster.CHANNEL, {
        type: msg.type as ContractEventType,
        payload: msg.payload,
      });
    });

    logger.info('[eventBroadcaster] Redis pub/sub enabled; subscribed to sse:events channel');
  }

  /**
   * Register an SSE subscriber. The subscriber's `send` callback will be
   * invoked for every event that passes:
   *   1. `isEventRelevantToWallet` — wallet-level tenant isolation (always applied)
   *   2. `isEventMatchingFilter`   — optional subscriber-level type/player filter
   */
  subscribe(subscriber: SseSubscriber): void {
    this._subscribers.add(subscriber);

    const listener = (event: BroadcastEvent) => {
      try {
        if (
          isEventRelevantToWallet(event, subscriber.wallet, subscriber.playerId) &&
          isEventMatchingFilter(event, subscriber.filter)
        ) {
          subscriber.send(event);
        }
      } catch (err) {
        logger.warn(
          `[eventBroadcaster] error sending event to ${subscriber.wallet}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };

    // Attach listener with the subscriber as the key so we can remove it later.
    (subscriber as SseSubscriber & { _listener?: (e: BroadcastEvent) => void })._listener = listener;
    this.on(EventBroadcaster.CHANNEL, listener);

    logger.debug(
      `[eventBroadcaster] subscribed wallet=${subscriber.wallet} total=${this._subscribers.size}`,
    );
  }

  /**
   * Remove an SSE subscriber and detach its event listener.
   * Must be called when the client disconnects to prevent memory leaks.
   */
  unsubscribe(subscriber: SseSubscriber): void {
    const listener = (subscriber as SseSubscriber & { _listener?: (e: BroadcastEvent) => void })._listener;
    if (listener) {
      this.off(EventBroadcaster.CHANNEL, listener);
    }
    this._subscribers.delete(subscriber);

    logger.debug(
      `[eventBroadcaster] unsubscribed wallet=${subscriber.wallet} total=${this._subscribers.size}`,
    );
  }

  /**
   * Emit an event to all relevant subscribers.
   * Called by the indexer after persisting a batch of events.
   * 
   * When Redis is configured, the event is also published to Redis so other
   * instances can receive it. Events are deduped by origin to avoid double
   * delivery when both a controller and the indexer emit the same logical event.
   */
  broadcast(event: BroadcastEvent): void {
    logger.debug(`[eventBroadcaster] broadcast type=${event.type} subscribers=${this._subscribers.size}`);
    
    const origin = INSTANCE_ID;
    
    // Publish to Redis if available
    const redisPublished = publishSseEvent({
      type: event.type,
      payload: event.payload,
      origin,
    });
    
    if (redisPublished) {
      metrics.published++;
      metrics.redisBroadcasts++;
    } else {
      metrics.published++;
    }
    
    // Local broadcast to in-process subscribers
    this.emit(EventBroadcaster.CHANNEL, event);
  }
  
  /**
   * Clean up Redis subscription on destroy.
   */
  _cleanup(): void {
    if (this._redisUnsubscribe) {
      this._redisUnsubscribe();
      this._redisUnsubscribe = undefined;
    }
  }
}

/** Convenience accessor for the singleton. */
/** Convenience accessor for the singleton. */
export const broadcaster = EventBroadcaster.getInstance();

