import { EventEmitter } from 'events';
import RedisMock from 'ioredis-mock';
import { InMemoryCacheStore } from '../../src/services/inMemoryCacheStore';
import { RedisCacheStore, RedisLike } from '../../src/services/redisCacheStore';
import { runCacheStoreContractTests } from './cacheStore.contract';

// Same contract, two backends. There is no live Redis server in this
// environment, so the Redis-backed run uses ioredis-mock — an in-memory fake
// that implements the ioredis client surface (get/set/del/exists/scan/
// pipeline, including PX/EX TTL support) so the SCAN-based invalidation and
// TTL-expiry paths in RedisCacheStore are exercised without a real server.
runCacheStoreContractTests('InMemoryCacheStore', () => new InMemoryCacheStore());

runCacheStoreContractTests('RedisCacheStore (ioredis-mock)', async () => {
  // ioredis-mock simulates multiple clients talking to the *same* server, so
  // separate `new RedisMock()` instances share state by default (mirroring
  // real Redis). Flush before each test so the contract suite sees an
  // isolated store per test, same as the fresh InMemoryCacheStore above.
  const client = new RedisMock();
  await client.flushall();
  return new RedisCacheStore(client as unknown as RedisLike);
});

describe('cache.ts public API (default in-memory backend)', () => {
  // REDIS_URL is unset in the test environment, so src/services/cache.ts
  // resolves to the InMemoryCacheStore backend.
  let cache: typeof import('../../src/services/cache');

  beforeEach(() => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cache = require('../../src/services/cache');
  });

  it('cacheSet/cacheGet round-trip a value', async () => {
    await cache.cacheSet('players:1', { name: 'Bob' });
    await expect(cache.cacheGet('players:1')).resolves.toEqual({ name: 'Bob' });
  });

  it('cacheGet returns undefined for a key that was never set', async () => {
    await expect(cache.cacheGet('nope')).resolves.toBeUndefined();
  });

  it('invalidatePlayerCache() clears players:list:* and, if given a playerId, players:<id>', async () => {
    await cache.cacheSet('players:list:region=africa', ['a', 'b']);
    await cache.cacheSet('players:list:region=europe', ['c']);
    await cache.cacheSet('players:42', { id: 42 });

    await cache.invalidatePlayerCache('42');

    await expect(cache.cacheGet('players:list:region=africa')).resolves.toBeUndefined();
    await expect(cache.cacheGet('players:list:region=europe')).resolves.toBeUndefined();
    await expect(cache.cacheGet('players:42')).resolves.toBeUndefined();
  });

  it('invalidatePlayerCache() without a playerId only clears the list cache', async () => {
    await cache.cacheSet('players:list:all', ['a']);
    await cache.cacheSet('players:99', { id: 99 });

    await cache.invalidatePlayerCache();

    await expect(cache.cacheGet('players:list:all')).resolves.toBeUndefined();
    await expect(cache.cacheGet('players:99')).resolves.toEqual({ id: 99 });
  });

  it('invalidatePlayerCache() increments cache_invalidation_total exactly once per operation', async () => {
    // Required after the beforeEach resetModules() so it is the same metrics
    // module instance the freshly-loaded cache module links to.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const metrics = require('../../src/middleware/metrics');
    metrics.resetMetrics();
    await cache.invalidatePlayerCache();
    expect(metrics.getCacheInvalidationTotal()).toBe(1);
    await cache.invalidatePlayerCache('42');
    expect(metrics.getCacheInvalidationTotal()).toBe(2);
  });

  it('invalidateMilestoneCache() clears the milestone entry and the player list cache', async () => {
    await cache.cacheSet('milestones:7', [{ type: 'identity' }]);
    await cache.cacheSet('players:list:all', ['x']);
    await cache.cacheSet('players:7', { id: 7 });

    await cache.invalidateMilestoneCache('7');

    await expect(cache.cacheGet('milestones:7')).resolves.toBeUndefined();
    await expect(cache.cacheGet('players:list:all')).resolves.toBeUndefined();
    await expect(cache.cacheGet('players:7')).resolves.toBeUndefined();
  });
});

// ─── Redis SCAN + DEL wildcard invalidation (mocked client) ───────────────────
//
// These tests drive RedisCacheStore.deleteByPrefix() with a hand-rolled fake
// Redis client so SCAN cursor progression, DEL batching, and error behavior
// are fully deterministic — no real Redis server required.

describe('RedisCacheStore deleteByPrefix (SCAN + DEL)', () => {
  /** Build a fake ioredis client whose scan() replays the given cursor/keys results in order. */
  function makeScanClient(scanResults: Array<[string, string[]]>) {
    let call = 0;
    const pipelineDels: string[][] = [];
    const client = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      exists: jest.fn(),
      // Regression guard: if any code path ever calls `keys`, it throws loudly
      // so the test fails instead of silently passing.
      keys: jest.fn(() => {
        throw new Error('KEYS must never be used for wildcard invalidation');
      }),
      scan: jest.fn(async () => {
        const [nextCursor, keys] = scanResults[Math.min(call, scanResults.length - 1)];
        call += 1;
        return [nextCursor, keys];
      }),
      pipeline: jest.fn(() => {
        const dels: string[] = [];
        pipelineDels.push(dels);
        return {
          del: (key: string) => {
            dels.push(key);
          },
          exec: jest.fn().mockResolvedValue(dels.map(() => [null, 1])),
        };
      }),
    };
    return { client: client as unknown as RedisLike, pipelineDels };
  }

  it('uses SCAN (MATCH players:list*) followed by pipeline DEL for matching keys', async () => {
    const { client, pipelineDels } = makeScanClient([
      ['0', ['players:list:a', 'players:list:b', 'players:list:c']],
    ]);
    const store = new RedisCacheStore(client);

    await store.deleteByPrefix('players:list');

    expect(client.scan).toHaveBeenCalledTimes(1);
    expect(client.scan).toHaveBeenCalledWith('0', 'MATCH', 'players:list*', 'COUNT', expect.any(Number));
    expect(pipelineDels).toEqual([['players:list:a', 'players:list:b', 'players:list:c']]);
  });

  it('deletes a single matching key', async () => {
    const { client, pipelineDels } = makeScanClient([['0', ['players:list:only']]]);
    const store = new RedisCacheStore(client);

    await store.deleteByPrefix('players:list');

    expect(pipelineDels).toEqual([['players:list:only']]);
  });

  it('handles zero matching keys without calling DEL', async () => {
    const { client, pipelineDels } = makeScanClient([['0', []]]);
    const store = new RedisCacheStore(client);

    await store.deleteByPrefix('players:list');

    expect(client.scan).toHaveBeenCalledTimes(1);
    expect(pipelineDels).toHaveLength(0);
  });

  it('keeps scanning across multiple iterations until the cursor returns to 0', async () => {
    const { client, pipelineDels } = makeScanClient([
      ['5', ['players:list:a']],
      ['12', ['players:list:b', 'players:list:c']],
      ['0', ['players:list:d']],
    ]);
    const store = new RedisCacheStore(client);

    await store.deleteByPrefix('players:list');

    // Three SCAN iterations: cursor 0 -> 5 -> 12 -> 0.
    expect(client.scan).toHaveBeenCalledTimes(3);
    expect(pipelineDels).toEqual([
      ['players:list:a'],
      ['players:list:b', 'players:list:c'],
      ['players:list:d'],
    ]);
  });

  it('never uses the blocking KEYS command for wildcard invalidation (regression guard)', async () => {
    const { client, pipelineDels } = makeScanClient([['0', ['players:list:a']]]);
    const store = new RedisCacheStore(client);

    await store.deleteByPrefix('players:list');

    // The fake client throws if `keys` is invoked; this assertion also fails
    // if a future refactor replaces SCAN with KEYS (the scan assertion
    // below would fail first, and `keys` would throw).
    expect((client as unknown as { keys: jest.Mock }).keys).not.toHaveBeenCalled();
    expect(client.scan).toHaveBeenCalled();
    expect(pipelineDels).toEqual([['players:list:a']]);
  });

  it('propagates Redis errors from SCAN so the cache layer can degrade gracefully', async () => {
    const client = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      exists: jest.fn(),
      pipeline: jest.fn(),
      scan: jest.fn().mockRejectedValue(new Error('connection lost')),
    } as unknown as RedisLike;
    const store = new RedisCacheStore(client);

    await expect(store.deleteByPrefix('players:list')).rejects.toThrow('connection lost');
  });

  it('Redis wildcard invalidation leaves single-player entries (players:<id>) untouched', async () => {
    const client = new RedisMock();
    await client.flushall();
    const store = new RedisCacheStore(client as unknown as RedisLike);

    await store.set('players:list:all', ['a']);
    await store.set('players:42', { id: 42 });

    await store.deleteByPrefix('players:list');

    expect(await store.get('players:list:all')).toBeUndefined();
    expect(await store.get('players:42')).toEqual({ id: 42 });
  });
});

// ─── Redis Pub/Sub cross-instance invalidation ────────────────────────────────

interface LoadedCache {
  cache: typeof import('../../src/services/cache');
  /** Fresh metrics module instance — the one the freshly-loaded cache links to. */
  metrics: typeof import('../../src/middleware/metrics');
  /** Fresh logger module instance — the one the freshly-loaded cache logs through. */
  logger: typeof import('../../src/utils/logger').logger;
}

/**
 * Load cache.ts with the redis module replaced by the given fake clients.
 *
 * `jest.resetModules()` gives the freshly-required cache module its own *new*
 * instances of every module it depends on (metrics, logger, redis). Any
 * metric/log assertion must therefore use the instances returned here — a
 * statically imported (or earlier-required) module would be a different,
 * stale instance whose counters are never touched by the cache code.
 */
function mockRedisModule(client: unknown, subscriber?: unknown): LoadedCache {
  jest.resetModules();
  jest.doMock('../../src/services/redis', () => ({
    getRedisClient: jest.fn(() => client),
    getRedisSubscriberClient: jest.fn(() => subscriber ?? null),
    closeRedisClients: jest.fn(),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const cache = require('../../src/services/cache');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const metrics = require('../../src/middleware/metrics');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const logger = require('../../src/utils/logger').logger;
  return { cache, metrics, logger };
}

describe('Redis Pub/Sub fanout (invalidate:players)', () => {
  afterEach(() => {
    jest.dontMock('../../src/services/redis');
    jest.resetModules();
  });

  it('subscribes to the invalidate:players channel on a dedicated subscriber connection', async () => {
    const main = { publish: jest.fn().mockResolvedValue(1) };
    const subscriber = new EventEmitter() as EventEmitter & {
      subscribe: jest.Mock;
      unsubscribe: jest.Mock;
      removeListener: jest.Mock;
    };
    subscriber.subscribe = jest.fn().mockResolvedValue(1);
    subscriber.unsubscribe = jest.fn().mockResolvedValue(1);
    subscriber.removeListener = jest.fn();

    const { cache } = mockRedisModule(main, subscriber);
    await cache.initCacheInvalidationSubscriber();
    await new Promise(setImmediate); // let the fire-and-forget subscribe land

    expect(subscriber.subscribe).toHaveBeenCalledWith('invalidate:players');

    await cache.closeCacheInvalidationSubscriber();
    expect(subscriber.unsubscribe).toHaveBeenCalledWith('invalidate:players');
    expect(subscriber.removeListener).toHaveBeenCalled();
  });

  it('does not subscribe when Redis is not configured (in-memory mode)', async () => {
    const { cache } = mockRedisModule(null, null);
    await expect(cache.initCacheInvalidationSubscriber()).resolves.toBeUndefined();
  });

  it('a received invalidate:players message clears local player-list entries but preserves single-player entries', async () => {
    const { cache, metrics } = mockRedisModule({ publish: jest.fn() });
    metrics.resetMetrics();
    const store = new InMemoryCacheStore();
    const handler = cache.createInvalidationHandler(store);

    // Write keys using the same namespace prefix the handler will clear.
    await store.set(cache.namespacedKey('players:list:all'), ['a']);
    await store.set(cache.namespacedKey('players:list:{"region":"eu"}'), ['b']);
    await store.set(cache.namespacedKey('players:42'), { id: 42 });

    await handler('invalidate:players', cache.INVALIDATION_MESSAGE);

    expect(await store.get(cache.namespacedKey('players:list:all'))).toBeUndefined();
    expect(await store.get(cache.namespacedKey('players:list:{"region":"eu"}'))).toBeUndefined();
    // Single-player entries must NOT be wildcard-invalidated.
    expect(await store.get(cache.namespacedKey('players:42'))).toEqual({ id: 42 });
    expect(metrics.getCacheInvalidationTotal()).toBe(1);
  });

  it('ignores messages on other channels', async () => {
    const { cache, metrics } = mockRedisModule({ publish: jest.fn() });
    metrics.resetMetrics();
    const store = new InMemoryCacheStore();
    const handler = cache.createInvalidationHandler(store);

    await store.set(cache.namespacedKey('players:list:all'), ['a']);
    await handler('some-other-channel', 'irrelevant');

    expect(await store.get(cache.namespacedKey('players:list:all'))).toEqual(['a']);
    expect(metrics.getCacheInvalidationTotal()).toBe(0);
  });

  it('fanout: multiple instances with independent stores each clear their own player-list cache', async () => {
    const { cache, metrics } = mockRedisModule({ publish: jest.fn() });
    metrics.resetMetrics();
    const storeA = new InMemoryCacheStore();
    const storeB = new InMemoryCacheStore();
    const handlerA = cache.createInvalidationHandler(storeA);
    const handlerB = cache.createInvalidationHandler(storeB);

    await storeA.set(cache.namespacedKey('players:list:a'), ['x']);
    await storeB.set(cache.namespacedKey('players:list:b'), ['y']);

    await Promise.all([
      handlerA('invalidate:players', cache.INVALIDATION_MESSAGE),
      handlerB('invalidate:players', cache.INVALIDATION_MESSAGE),
    ]);

    expect(await storeA.get(cache.namespacedKey('players:list:a'))).toBeUndefined();
    expect(await storeB.get(cache.namespacedKey('players:list:b'))).toBeUndefined();
    expect(metrics.getCacheInvalidationTotal()).toBe(2);
  });

  it('end-to-end with ioredis-mock: invalidatePlayerCache publishes, the subscriber receives and clears', async () => {
    const main = new RedisMock();
    const subscriber = main.duplicate();
    const { cache, metrics } = mockRedisModule(main, subscriber);
    metrics.resetMetrics();

    await cache.initCacheInvalidationSubscriber();
    await new Promise(setImmediate);

    const publishSpy = jest.spyOn(main, 'publish');
    await cache.cacheSet('players:list:{}', ['cached']);
    await cache.cacheSet('players:42', { id: 42 });

    await cache.invalidatePlayerCache('42');

    // Allow the pub/sub message to travel through ioredis-mock to the subscriber.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(publishSpy).toHaveBeenCalledWith('invalidate:players', cache.INVALIDATION_MESSAGE);
    expect(await cache.cacheGet('players:list:{}')).toBeUndefined();
    expect(await cache.cacheGet('players:42')).toBeUndefined();
    // One increment for the local invalidation + one for the message received
    // by the subscriber connection.
    expect(metrics.getCacheInvalidationTotal()).toBe(2);

    await cache.closeCacheInvalidationSubscriber();
  });
});

// ─── Redis-down graceful degradation ─────────────────────────────────────────

describe('Redis-down graceful degradation', () => {
  afterEach(() => {
    jest.dontMock('../../src/services/redis');
    jest.resetModules();
  });

  /** A fake ioredis client whose every command rejects (Redis unreachable). */
  function failingRedisClient() {
    return {
      get: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      set: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      del: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      exists: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      scan: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      pipeline: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      publish: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    };
  }

  it('invalidatePlayerCache resolves (no crash) and logs a warning when Redis scan/delete/publish fail', async () => {
    const { cache, logger } = mockRedisModule(failingRedisClient());
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(cache.invalidatePlayerCache('42')).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalidation failed'));

    warnSpy.mockRestore();
  });

  it('cache reads degrade to a miss and writes are best-effort when Redis is down', async () => {
    const { cache, logger } = mockRedisModule(failingRedisClient());
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

    await expect(cache.cacheGet('players:list:x')).resolves.toBeUndefined();
    await expect(cache.cacheSet('players:list:x', [1])).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it('the in-memory fallback keeps serving cache reads when Redis is not configured', async () => {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cache = require('../../src/services/cache');

    await cache.cacheSet('players:1', { name: 'Bob' });
    await expect(cache.cacheGet('players:1')).resolves.toEqual({ name: 'Bob' });
  });
});

describe('cache.ts Redis backend error handling', () => {
  // A Redis client's 'error' event with no listener is treated by Node as an
  // uncaught exception and crashes the process. Simulate that event here and
  // assert the module survives it, guarding against the listener being
  // dropped in a future refactor.
  it('does not crash when the Redis client emits an error event', async () => {
    const fakeClient = new EventEmitter();
    jest.resetModules();
    jest.doMock('ioredis', () => ({
      __esModule: true,
      default: jest.fn(() => fakeClient),
    }));
    jest.doMock('../../src/config', () => ({
      __esModule: true,
      default: { ...jest.requireActual('../../src/config').default, redisUrl: 'redis://fake:6379' },
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../src/services/cache');

    expect(() => fakeClient.emit('error', new Error('connection refused'))).not.toThrow();

    jest.dontMock('ioredis');
    jest.dontMock('../../src/config');
    jest.resetModules();
  });
});

// ─── #672: Namespace isolation — two CACHE_NAMESPACE values never collide ────
//
// The cache module is re-loaded twice with different CACHE_NAMESPACE configs
// and the same underlying RedisMock instance (same server). Keys written under
// namespace A must never be readable under namespace B.

describe('cache namespace isolation (#672)', () => {
  function loadCacheWithNamespace(namespace: string, redisClient: unknown) {
    jest.resetModules();
    jest.doMock('../../src/services/redis', () => ({
      getRedisClient: jest.fn(() => redisClient),
      getRedisSubscriberClient: jest.fn(() => null),
      closeRedisClients: jest.fn(),
    }));
    jest.doMock('../../src/config', () => ({
      __esModule: true,
      default: {
        ...jest.requireActual('../../src/config').default,
        cacheNamespace: namespace,
        playerCacheTtlMs: 60000,
      },
    }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../src/services/cache') as typeof import('../../src/services/cache');
  }

  afterEach(() => {
    jest.dontMock('../../src/services/redis');
    jest.dontMock('../../src/config');
    jest.resetModules();
  });

  it('two deployments with different namespaces sharing the same Redis store never read each other\'s keys', async () => {
    // Use a single shared RedisMock instance (same "server") to simulate
    // two deployments connected to the same Redis cluster.
    const sharedRedis = new RedisMock();
    await sharedRedis.flushall();

    const production = loadCacheWithNamespace('production', sharedRedis);
    const staging = loadCacheWithNamespace('staging', sharedRedis);

    // Each namespace writes its own value for the same logical key.
    await production.cacheSet('players:list:{}', [{ id: 'prod-player' }]);
    await staging.cacheSet('players:list:{}', [{ id: 'staging-player' }]);

    // Each namespace reads back only its own value.
    await expect(production.cacheGet('players:list:{}')).resolves.toEqual([{ id: 'prod-player' }]);
    await expect(staging.cacheGet('players:list:{}')).resolves.toEqual([{ id: 'staging-player' }]);
  });

  it('namespacedKey() uses the configured namespace as prefix', () => {
    const cache = loadCacheWithNamespace('myapp', null);
    expect(cache.namespacedKey('players:list:foo')).toBe('myapp:players:list:foo');
    expect(cache.namespacedKey('players:42')).toBe('myapp:players:42');
  });

  it('invalidatePlayerCache() in one namespace does not affect the other namespace\'s keys', async () => {
    const sharedRedis = new RedisMock();
    await sharedRedis.flushall();

    const production = loadCacheWithNamespace('production', sharedRedis);
    const staging = loadCacheWithNamespace('staging', sharedRedis);

    await production.cacheSet('players:list:all', [1, 2, 3]);
    await staging.cacheSet('players:list:all', [4, 5, 6]);

    // Invalidate only production namespace.
    await production.invalidatePlayerCache();

    // Production list is gone.
    await expect(production.cacheGet('players:list:all')).resolves.toBeUndefined();
    // Staging list survives.
    await expect(staging.cacheGet('players:list:all')).resolves.toEqual([4, 5, 6]);
  });
});
