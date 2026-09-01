/**
 * Search cache.
 *
 * Backend is selected once at module load based on `REDIS_URL`:
 *   - set   -> RedisCacheStore — cache state is shared across every backend
 *              instance, so a load-balanced multi-instance deployment stays
 *              consistent instead of each process re-hitting IPFS/DB.
 *   - unset -> InMemoryCacheStore — process-local, zero setup. Default for
 *              local dev and CI.
 *
 * Cache key conventions:
 *   players:list:<hash>  – paginated player search results (keyed by filter params)
 *   players:<playerId>   – single player profile
 *   milestones:<playerId> – milestone list for a player
 *
 * Invalidation:
 *   `invalidatePlayerCache()` clears every `players:list:*` entry (via the
 *   store's prefix deletion — SCAN + DEL on Redis, never KEYS) and optionally
 *   the single `players:<playerId>` entry. Single-player entries are only ever
 *   invalidated individually by id — never via a wildcard.
 *
 * Cross-instance fanout (Redis deployments only):
 *   When Redis is configured, each invalidation also publishes a message on
 *   the `invalidate:players` pub/sub channel. Every instance runs a subscriber
 *   (on a dedicated duplicated connection, since ioredis forbids normal
 *   commands on a connection in subscriber mode) that clears its local
 *   player-list cache on receipt, so a player state change on instance A is
 *   reflected on instances B and C without waiting for the TTL.
 *
 * Graceful degradation:
 *   Cache operations are best-effort — a Redis failure (down, unreachable,
 *   scan/delete/publish error) is logged as a warning and never thrown, so the
 *   API keeps serving requests from the DB/IPFS while the in-memory TTL
 *   (`PLAYER_CACHE_TTL_MS`, default 60000) keeps working as before.
 *
 * All exported functions are async: Redis access is inherently network I/O,
 * so every call site must `await` these calls (they returned void
 * synchronously before this module supported a Redis backend).
 */
import { getRedisClient, getRedisSubscriberClient } from './redis';
import config from '../config';
import { CacheStore } from './cacheStore';
import { InMemoryCacheStore } from './inMemoryCacheStore';
import { RedisCacheStore } from './redisCacheStore';
import {
  recordCacheHit,
  recordCacheMiss,
  recordCacheInvalidation,
} from '../middleware/metrics';
import { logger } from '../utils/logger';

/**
 * Redis Pub/Sub channel used to fan out player-list cache invalidations to
 * every backend instance. The payload is informational (`INVALIDATION_MESSAGE`);
 * any message on this channel means "clear your local player-list cache".
 */
export const INVALIDATION_CHANNEL = 'invalidate:players';

/** Stable, versioned payload published on `INVALIDATION_CHANNEL`. */
export const INVALIDATION_MESSAGE = JSON.stringify({
  type: 'player_list',
  action: 'invalidate',
});

/**
 * Maximum number of entries kept in the process-local in-memory cache.
 * Configurable via PLAYER_CACHE_MAX_SIZE; defaults to 1000 entries as a
 * stopgap against unbounded growth while Redis migration is pending.
 */
const DEFAULT_MAX_CACHE_SIZE = 1000;

function getMaxCacheSize(): number {
  const configured = Number(process.env.PLAYER_CACHE_MAX_SIZE);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_CACHE_SIZE;
}

/**
 * Process-local cache bound that layers LRU eviction on top of the existing
 * TTL-based InMemoryCacheStore. Access order is tracked with a Map (iteration
 * order = insertion order; re-inserting a key moves it to the end). When the
 * configured size cap is exceeded, the first key in the map is evicted.
 */
class BoundedInMemoryCacheStore implements CacheStore {
  private readonly store = new InMemoryCacheStore();
  private readonly accessOrder = new Map<string, true>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const value = await this.store.get<T>(key);
    if (value === undefined) {
      if (this.accessOrder.delete(key)) {
        await this.store.del(key);
      }
      return undefined;
    }
    this.touch(key);
    return value;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    await this.store.set(key, value, ttlMs);
    this.touch(key);
    await this.evictIfNeeded();
  }

  async del(key: string): Promise<void> {
    await this.store.del(key);
    this.accessOrder.delete(key);
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    await this.store.deleteByPrefix(prefix);
    for (const key of this.accessOrder.keys()) {
      if (key.startsWith(prefix)) {
        this.accessOrder.delete(key);
      }
    }
  }

  private touch(key: string): void {
    this.accessOrder.delete(key);
    this.accessOrder.set(key, true);
  }

  private async evictIfNeeded(): Promise<void> {
    while (this.accessOrder.size > this.maxSize) {
      const oldestKey = this.accessOrder.keys().next().value;
      if (oldestKey === undefined) break;
      this.accessOrder.delete(oldestKey);
      await this.store.del(oldestKey);
    }
  }
}

function createStore(): CacheStore {
  const client = getRedisClient();
  if (client) {
    return new RedisCacheStore(client);
  }
  return new BoundedInMemoryCacheStore(getMaxCacheSize());
}

const store: CacheStore = createStore();

/**
 * Prefix every raw cache key with the configured namespace so that two
 * deployments (e.g. staging + production, or a blue/green pair) sharing the
 * same Redis cluster never read or overwrite each other's entries (#672).
 *
 * The namespace defaults to NODE_ENV — providing isolation out-of-the-box —
 * and can be overridden with the CACHE_NAMESPACE environment variable for
 * more fine-grained control (e.g. `blue`, `green`, `staging-pr-123`).
 *
 * The separator `:` is consistent with the existing key convention
 * (`players:list:…`, `players:…`, `milestones:…`) so that SCAN patterns
 * and `deleteByPrefix` calls naturally extend to the namespaced form.
 */
export function namespacedKey(rawKey: string): string {
  return `${config.cacheNamespace}:${rawKey}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Fetch a cached value. Returns undefined if missing or expired. */
export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const value = await store.get<T>(namespacedKey(key));
    if (value !== undefined) {
      recordCacheHit();
    } else {
      recordCacheMiss();
    }
    return value;
  } catch (err) {
    // Redis is unavailable — degrade to a miss so the caller falls through to
    // the DB/IPFS and the API stays serviceable.
    logger.warn(`[cache] cacheGet failed for key "${key}"; treating as a miss: ${errMessage(err)}`);
    recordCacheMiss();
    return undefined;
  }
}

/** Store a value under `key`, expiring after `ttlMs` (default: config.playerCacheTtlMs). */
export async function cacheSet<T>(
  key: string,
  value: T,
  ttlMs: number = config.playerCacheTtlMs
): Promise<void> {
  try {
    await store.set(namespacedKey(key), value, ttlMs);
  } catch (err) {
    // Best-effort write: a Redis failure must not break the request that
    // produced the value.
    logger.warn(`[cache] cacheSet failed for key "${key}"; continuing without caching: ${errMessage(err)}`);
  }
}

/**
 * Millisecond timestamp of the last player-list mutation (registration, tier
 * promotion, profile update, etc.). Used as Last-Modified / list ETag input
 * for GET /api/players cheap revalidation.
 */
let playerListLastModifiedMs = Date.now();

/** Latest list-mutation time (ms since epoch). */
export function getPlayerListLastModified(): number {
  return playerListLastModifiedMs;
}

/** Test helper — reset the list validator clock without going through Redis. */
export function __setPlayerListLastModifiedForTests(ms: number): void {
  playerListLastModifiedMs = ms;
}

/**
 * Invalidate player-list cache entries (`players:list:*` — every paginated
 * search result) and, when `playerId` is given, the individual
 * `players:<playerId>` entry.
 *
 * On Redis deployments the invalidation is also published on the
 * `invalidate:players` channel so every other instance clears its local
 * player-list cache. Failures are logged and swallowed: the invalidation must
 * never crash the caller (e.g. the indexer mid-batch) nor fail an indexing
 * operation whose DB write already succeeded.
 *
 * Also bumps {@link getPlayerListLastModified} so HTTP cache validators
 * (Last-Modified / list ETag on GET /api/players) change immediately.
 */
export async function invalidatePlayerCache(playerId?: string): Promise<void> {
  playerListLastModifiedMs = Date.now();
  try {
    await store.deleteByPrefix(namespacedKey('players:list'));
    if (playerId) {
      await store.del(namespacedKey(`players:${playerId}`));
    }
    await publishInvalidation();
  } catch (err) {
    logger.warn(`[cache] player cache invalidation failed: ${errMessage(err)}`);
  } finally {
    recordCacheInvalidation();
  }
}

export async function invalidateMilestoneCache(playerId: string): Promise<void> {
  try {
    await store.del(namespacedKey(`milestones:${playerId}`));
  } catch (err) {
    logger.warn(`[cache] milestone cache invalidation failed for "${playerId}": ${errMessage(err)}`);
  }
  // Also bust the player list so updated progress tier is reflected
  await invalidatePlayerCache(playerId);
}

// ─── Cross-instance Pub/Sub invalidation ──────────────────────────────────────

/**
 * Publish an invalidation message on the shared Redis channel so sibling
 * instances clear their local player-list caches. No-op when Redis is not
 * configured (in-memory mode has no siblings). Publishing is allowed on the
 * regular command connection — only subscriber mode requires a dedicated one.
 */
async function publishInvalidation(): Promise<void> {
  const client = getRedisClient();
  if (!client) return;
  await client.publish(INVALIDATION_CHANNEL, INVALIDATION_MESSAGE);
}

/**
 * Build the handler applied when an `invalidate:players` message is received.
 *
 * Only player-list entries are cleared — single-player entries
 * (`players:<id>`) are never wildcard-invalidated; they remain individually
 * addressable and are invalidated by id when their owner changes.
 *
 * Exported as a factory so tests can attach independent handlers to multiple
 * fake subscriber connections and verify fanout semantics per store.
 */
export function createInvalidationHandler(
  storeToUse: CacheStore
): (channel: string, message: string) => Promise<void> {
  return async (channel: string, _message: string): Promise<void> => {
    if (channel !== INVALIDATION_CHANNEL) return;
    try {
      playerListLastModifiedMs = Date.now();
      await storeToUse.deleteByPrefix(namespacedKey('players:list'));
    } catch (err) {
      logger.warn(
        `[cache] failed to clear local player-list cache after "${INVALIDATION_CHANNEL}" message: ${errMessage(err)}`
      );
    } finally {
      recordCacheInvalidation();
    }
  };
}

const invalidationMessageHandler = createInvalidationHandler(store);

let subscriberInitialized = false;

/**
 * Start listening for `invalidate:players` messages on a dedicated duplicated
 * Redis connection and clear the local player-list cache when one arrives.
 *
 * Idempotent. Never blocks startup: the subscribe command is issued
 * best-effort (ioredis buffers it and retries until Redis is reachable), so a
 * temporarily unavailable Redis only produces a warning, not a startup hang.
 */
export async function initCacheInvalidationSubscriber(): Promise<void> {
  if (subscriberInitialized) return;
  subscriberInitialized = true;
  const client = getRedisSubscriberClient();
  if (!client) return;
  client.on('message', invalidationMessageHandler);
  client.subscribe(INVALIDATION_CHANNEL).catch((err: unknown) => {
    logger.warn(`[cache] failed to subscribe to "${INVALIDATION_CHANNEL}": ${errMessage(err)}`);
  });
  logger.info(`[cache] listening on "${INVALIDATION_CHANNEL}" for cross-instance cache invalidation`);
}

/**
 * Stop the cross-instance invalidation subscriber (unsubscribe and detach the
 * handler). Does not close the underlying connection — use
 * `closeRedisClients()` for full shutdown.
 */
export async function closeCacheInvalidationSubscriber(): Promise<void> {
  if (!subscriberInitialized) return;
  subscriberInitialized = false;
  const client = getRedisSubscriberClient();
  if (!client) return;
  client.removeListener('message', invalidationMessageHandler);
  try {
    await client.unsubscribe(INVALIDATION_CHANNEL);
  } catch (err) {
    logger.warn(`[cache] failed to unsubscribe from "${INVALIDATION_CHANNEL}": ${errMessage(err)}`);
  }
}
