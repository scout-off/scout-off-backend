import type Redis from 'ioredis';
import { CacheStore } from './cacheStore';
import { logger } from '../utils/logger';

const SCAN_COUNT = 100;

/**
 * Minimal surface of the ioredis client this store relies on. Declared
 * explicitly (rather than depending on the full `Redis` class) so tests can
 * substitute a lightweight fake (e.g. ioredis-mock) without needing a real
 * type-compatible client.
 */
export type RedisLike = Pick<Redis, 'get' | 'set' | 'del' | 'exists' | 'scan' | 'pipeline'>;

/**
 * Redis-backed cache store for multi-instance deployments — cache state is
 * shared across every backend process instead of living in a single
 * process's memory.
 *
 * Values are JSON-serialized. TTL is delegated to Redis's native `PX` expiry
 * (`SET key value PX ttlMs`) rather than tracked in JS, so a key genuinely
 * disappears from Redis at expiry and reads return undefined — the same
 * observable behavior as the in-memory store.
 *
 * `deleteByPrefix` uses `SCAN ... MATCH <prefix>*` in a cursor loop (never
 * `KEYS *`, which blocks the whole server) and pipelines the deletes.
 *
 * ## Failure behavior
 *
 * All methods catch Redis errors and degrade gracefully:
 *
 * - `get`  → returns `undefined` (cache miss)
 * - `set`  → silently swallowed (write failure is non-fatal)
 * - `del`  → silently swallowed (delete failure is non-fatal)
 * - `has`  → returns `false`
 * - `deleteByPrefix` → silently swallowed
 *
 * Errors are logged at `warn` level so operators can detect Redis problems
 * without application requests failing.  Redis internals are never leaked to
 * API clients.
 */
export class RedisCacheStore implements CacheStore {
  constructor(private readonly client: RedisLike) {}

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.client.get(key);
      if (raw === null || raw === undefined) return undefined;
      return JSON.parse(raw) as T;
    } catch (err) {
      logger.warn('[cache] Redis get failed, treating as cache miss', { key, err });
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      if (ttlMs !== undefined) {
        // ttlMs=0 means "expire immediately" — consistent with InMemoryCacheStore,
        // which sets expiresAt = Date.now() + 0 so the entry is expired on the
        // very next read (#673). Redis rejects PX 0 with an error, so we skip
        // the write entirely; the entry is treated as instantly expired from
        // the caller's perspective (get() will return undefined, has() false).
        if (ttlMs === 0) return;
        await this.client.set(key, serialized, 'PX', ttlMs);
      } else {
        await this.client.set(key, serialized);
      }
    } catch (err) {
      logger.warn('[cache] Redis set failed, write skipped', { key, err });
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      logger.warn('[cache] Redis del failed', { key, err });
    }
  }

  async has(key: string): Promise<boolean> {
    try {
      const exists = await this.client.exists(key);
      return exists === 1;
    } catch (err) {
      logger.warn('[cache] Redis exists failed, treating as cache miss', { key, err });
      return false;
    }
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.client.scan(
          cursor,
          'MATCH',
          `${prefix}*`,
          'COUNT',
          SCAN_COUNT
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          const pipeline = this.client.pipeline();
          for (const key of keys) pipeline.del(key);
          await pipeline.exec();
        }
      } while (cursor !== '0');
    } catch (err) {
      logger.warn('[cache] Redis deleteByPrefix failed', { prefix, err });
    }
  }
}
