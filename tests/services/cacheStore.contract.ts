import { CacheStore } from '../../src/services/cacheStore';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Shared contract test suite for CacheStore implementations. Run it once per
 * backend (in-memory, Redis) so every backend is held to the exact same
 * get/set/TTL/invalidation behavior — callers should never be able to
 * observe a difference between them.
 *
 * TTL assertions use short *real* delays rather than jest fake timers:
 * Redis expiry is enforced by the Redis server itself and does not respect
 * fake timers, so the same real-clock approach is used for both backends to
 * keep the contract identical.
 */
export function runCacheStoreContractTests(
  name: string,
  storeFactory: () => CacheStore | Promise<CacheStore>
): void {
  describe(`CacheStore contract: ${name}`, () => {
    let store: CacheStore;

    beforeEach(async () => {
      store = await storeFactory();
    });

    it('returns undefined for a missing key', async () => {
      await expect(store.get('missing-key')).resolves.toBeUndefined();
    });

    it('round-trips a stored value', async () => {
      await store.set('players:1', { name: 'Alice', tier: 2 });
      await expect(store.get('players:1')).resolves.toEqual({ name: 'Alice', tier: 2 });
    });

    it('overwrites an existing value', async () => {
      await store.set('key', 'first');
      await store.set('key', 'second');
      await expect(store.get('key')).resolves.toBe('second');
    });

    it('has() reflects presence of a non-expired key', async () => {
      await expect(store.has('key')).resolves.toBe(false);
      await store.set('key', 'value');
      await expect(store.has('key')).resolves.toBe(true);
    });

    it('del() removes a key', async () => {
      await store.set('key', 'value');
      await store.del('key');
      await expect(store.get('key')).resolves.toBeUndefined();
      await expect(store.has('key')).resolves.toBe(false);
    });

    it('del() on a missing key is a no-op', async () => {
      await expect(store.del('does-not-exist')).resolves.toBeUndefined();
    });

    it('expires a value after its TTL elapses', async () => {
      await store.set('short-lived', 'value', 75);
      await expect(store.get('short-lived')).resolves.toBe('value');
      await sleep(200);
      await expect(store.get('short-lived')).resolves.toBeUndefined();
      await expect(store.has('short-lived')).resolves.toBe(false);
    }, 10000);

    /**
     * ttlMs=0 contract (#673): both implementations must treat a zero TTL as
     * "expire immediately". The entry must never be readable after set() returns —
     * neither get() nor has() should see it.
     *
     * InMemoryCacheStore: expiresAt = Date.now() + 0, so the entry is instantly
     * past its deadline and filtered on the very next read.
     * RedisCacheStore: a PX 0 write is skipped entirely (Redis rejects it), which
     * produces the same observable result — the key is never visible.
     */
    it('ttlMs=0 — entry is never readable (identical behavior across backends)', async () => {
      await store.set('zero-ttl', 'should-never-be-seen', 0);
      await expect(store.get('zero-ttl')).resolves.toBeUndefined();
      await expect(store.has('zero-ttl')).resolves.toBe(false);
    });

    it('keeps a value without a TTL beyond a short window', async () => {
      await store.set('persistent', 'value');
      await sleep(100);
      await expect(store.get('persistent')).resolves.toBe('value');
    }, 10000);

    it('deleteByPrefix removes only matching keys', async () => {
      await store.set('players:list:a', [1]);
      await store.set('players:list:b', [2]);
      await store.set('players:42', { id: 42 });
      await store.deleteByPrefix('players:list');
      await expect(store.get('players:list:a')).resolves.toBeUndefined();
      await expect(store.get('players:list:b')).resolves.toBeUndefined();
      await expect(store.get('players:42')).resolves.toEqual({ id: 42 });
    });
  });
}
