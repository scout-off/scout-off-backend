import Redis from 'ioredis';
import { getDriver, getFeatureFlag, upsertFeatureFlag } from '../../src/db';
import { RedisRateLimitStore } from '../../src/middleware/redisRateLimitStore';
import { RedisCacheStore } from '../../src/services/redisCacheStore';
import {
  cacheGet,
  cacheSet,
  closeCacheInvalidationSubscriber,
  initCacheInvalidationSubscriber,
  namespacedKey,
  INVALIDATION_CHANNEL,
  INVALIDATION_MESSAGE,
} from '../../src/services/cache';
import { closeRedisClients, getRedisClient, getRedisSubscriberClient } from '../../src/services/redis';
import { initBlocklist, isTokenRevoked } from '../../src/services/tokenBlocklist';
import {
  clearFeatureFlagCache,
  isFeatureEnabled,
  setFeatureFlag,
  FeatureFlags,
} from '../../src/services/featureFlags';

const redisUrl = process.env.REDIS_URL;
const describeWithRedis = redisUrl ? describe : describe.skip;

async function waitFor(
  condition: () => Promise<boolean>,
  message: string,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

describeWithRedis('production Redis integration', () => {
  let redis: Redis;
  const prefix = `redis-integration:${process.pid}:${Date.now()}:`;

  beforeAll(async () => {
    redis = new Redis(redisUrl!);
    redis.on('error', (err) => {
      console.error('[redis-integration] Redis client error:', err);
    });
    await expect(redis.ping()).resolves.toBe('PONG');
  });

  afterAll(async () => {
    await closeCacheInvalidationSubscriber();
    await closeRedisClients();
    let cursor = '0';
    const testKeys: string[] = [];
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `*${prefix}*`, 'COUNT', 100);
      cursor = nextCursor;
      testKeys.push(...keys);
    } while (cursor !== '0');
    if (testKeys.length > 0) {
      await redis.del(...testKeys);
    }
    await redis.quit();
  });

  it('executes the rate-limit Lua script atomically and expires its counter', async () => {
    const store = new RedisRateLimitStore(redis);
    const key = `${prefix}rate-limit`;
    const limit = 20;
    const results = await Promise.all(
      Array.from({ length: limit + 5 }, () => store.increment(key, 250)),
    );

    expect(results.map(({ count }) => count).sort((a, b) => a - b))
      .toEqual(Array.from({ length: limit + 5 }, (_, i) => i + 1));
    expect(results.every(({ resetAt }) => resetAt > Date.now())).toBe(true);
    await waitFor(async () => (await redis.exists(`rate-limit:${key}`)) === 0, 'rate-limit key expiry');
    await expect(store.increment(key, 250)).resolves.toMatchObject({ count: 1 });
  });

  it('uses real Redis TTL, SCAN cursor iteration, and pipelined deletion', async () => {
    const store = new RedisCacheStore(redis);
    const cachePrefix = `${prefix}cache:`;
    const keys = Array.from({ length: 250 }, (_, i) => `${cachePrefix}${i}`);
    await Promise.all(keys.map((key) => store.set(key, { key })));
    await store.set(`${prefix}unrelated`, 'keep');
    await store.set(`${cachePrefix}expires`, 'short-lived', 200);

    await expect(store.get(`${cachePrefix}1`)).resolves.toEqual({ key: `${cachePrefix}1` });
    await waitFor(async () => (await redis.exists(`${cachePrefix}expires`)) === 0, 'cache key expiry');

    await store.deleteByPrefix(cachePrefix);

    const exists = await redis.exists(...keys);
    expect(exists).toBe(0);
    await expect(redis.get(`${prefix}unrelated`)).resolves.toBe(JSON.stringify('keep'));
  });

  it('delivers real Pub/Sub invalidations to the cache subscriber', async () => {
    const publisher = getRedisClient();
    const subscriber = getRedisSubscriberClient();
    expect(publisher).not.toBeNull();
    expect(subscriber).not.toBeNull();

    await initCacheInvalidationSubscriber();
    await waitFor(async () => {
      const response = await redis.pubsub('numsub', INVALIDATION_CHANNEL);
      return Number(response[1]) > 0;
    }, 'cache invalidation subscription');

    const listKey = `players:list:${prefix}pubsub`;
    const profileKey = `players:${prefix}pubsub`;
    await cacheSet(listKey, ['cached']);
    await cacheSet(profileKey, { player: 'cached' });
    await expect(cacheGet(listKey)).resolves.toEqual(['cached']);

    await publisher!.publish(INVALIDATION_CHANNEL, INVALIDATION_MESSAGE);
    await waitFor(
      async () => (await redis.exists(namespacedKey(listKey))) === 0,
      'cache-list invalidation',
    );

    await expect(cacheGet(profileKey)).resolves.toEqual({ player: 'cached' });
  });

  it('warms the token revocation blocklist from the database on startup', async () => {
    const jti = `${prefix}revoked-token`;
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const key = `jti:revoked:${jti}`;

    await redis.del(key);
    await getDriver().run('DELETE FROM revoked_tokens WHERE jti = ?', [jti]);
    await getDriver().run(
      'INSERT INTO revoked_tokens (jti, revoked_at, expires_at) VALUES (?, ?, ?)',
      [jti, Math.floor(Date.now() / 1000), expiresAt],
    );

    initBlocklist();
    await waitFor(async () => (await redis.exists(key)) === 1, 'token blocklist warm-up');

    expect(await redis.ttl(key)).toBeGreaterThan(0);
    await expect(isTokenRevoked(jti)).resolves.toBe(true);
  });

  it('updates and reloads a feature flag against the real database', async () => {
    const name = FeatureFlags.PLAYER_TOKENS_ENABLED;
    const existing = await getFeatureFlag(name);
    clearFeatureFlagCache();

    try {
      await setFeatureFlag(name, true, 'redis-integration-test');
      await expect(isFeatureEnabled(name)).resolves.toBe(true);
      clearFeatureFlagCache();
      await expect(isFeatureEnabled(name)).resolves.toBe(true);
    } finally {
      if (existing) {
        await upsertFeatureFlag(existing);
      }
      clearFeatureFlagCache();
    }
  });
});
