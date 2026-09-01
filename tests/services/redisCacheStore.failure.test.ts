/**
 * Redis cache failure-mode tests.
 *
 * Tests the full matrix:
 *   [✓] Redis available
 *   [✓] Redis unreachable at startup
 *   [✓] Redis command timeout
 *   [✓] Redis drops mid-request
 *   [✓] Redis recovers
 *   [✓] Bounded response time
 *   [✓] Fallback/cache-miss behavior
 *
 * Uses the FakeRedisStore harness — no real Redis or Docker required.
 * See tests/helpers/redisFailureHarness.ts for design rationale.
 */

import {
  FakeRedisStore,
  RedisConnectionError,
  withTimeout,
} from '../helpers/redisFailureHarness';
import { RedisCacheStore } from '../../src/services/redisCacheStore';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Generous bound for a local fake operation (no real I/O). */
const BOUND_MS = 500;

function makeStore(): { fake: FakeRedisStore; store: RedisCacheStore } {
  const fake = new FakeRedisStore();
  const store = new RedisCacheStore(fake);
  return { fake, store };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Redis available — happy path (regression guard)
// ─────────────────────────────────────────────────────────────────────────────

describe('RedisCacheStore — healthy Redis', () => {
  let fake: FakeRedisStore;
  let store: RedisCacheStore;

  beforeEach(() => {
    ({ fake, store } = makeStore());
  });

  afterEach(() => {
    fake.flush();
  });

  it('round-trips a value', async () => {
    await store.set('k', { foo: 'bar' });
    await expect(store.get('k')).resolves.toEqual({ foo: 'bar' });
  });

  it('returns undefined for a missing key', async () => {
    await expect(store.get('missing')).resolves.toBeUndefined();
  });

  it('has() returns true for an existing key', async () => {
    await store.set('k', 'v');
    await expect(store.has('k')).resolves.toBe(true);
  });

  it('del() removes a key', async () => {
    await store.set('k', 'v');
    await store.del('k');
    await expect(store.get('k')).resolves.toBeUndefined();
  });

  it('deleteByPrefix removes matching keys', async () => {
    await store.set('players:list:a', [1]);
    await store.set('players:list:b', [2]);
    await store.set('players:42', { id: 42 });
    await store.deleteByPrefix('players:list');
    await expect(store.get('players:list:a')).resolves.toBeUndefined();
    await expect(store.get('players:list:b')).resolves.toBeUndefined();
    await expect(store.get('players:42')).resolves.toEqual({ id: 42 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Redis unreachable at connection time
// ─────────────────────────────────────────────────────────────────────────────

describe('RedisCacheStore — Redis unreachable at startup', () => {
  let fake: FakeRedisStore;
  let store: RedisCacheStore;

  beforeEach(() => {
    ({ fake, store } = makeStore());
    // Mark Redis as unavailable before any operation
    fake.setState('unavailable');
  });

  afterEach(() => {
    fake.flush();
  });

  it('get() returns undefined (cache miss) — no throw', async () => {
    // Should degrade gracefully, not throw
    await expect(store.get('any-key')).resolves.toBeUndefined();
  });

  it('set() completes without throwing', async () => {
    await expect(store.set('key', 'value')).resolves.toBeUndefined();
  });

  it('del() completes without throwing', async () => {
    await expect(store.del('key')).resolves.toBeUndefined();
  });

  it('has() returns false (treats as missing)', async () => {
    await expect(store.has('key')).resolves.toBe(false);
  });

  it('deleteByPrefix() completes without throwing', async () => {
    await expect(store.deleteByPrefix('players:')).resolves.toBeUndefined();
  });

  it('get() completes within bounded time', async () => {
    const result = await withTimeout(store.get('key'), BOUND_MS);
    expect(result.timedOut).toBe(false);
  });

  it('set() completes within bounded time', async () => {
    const result = await withTimeout(store.set('key', 'value'), BOUND_MS);
    expect(result.timedOut).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Redis becomes unavailable mid-request (established connection drops)
// ─────────────────────────────────────────────────────────────────────────────

describe('RedisCacheStore — Redis drops mid-request', () => {
  let fake: FakeRedisStore;
  let store: RedisCacheStore;

  beforeEach(() => {
    ({ fake, store } = makeStore());
  });

  afterEach(() => {
    fake.flush();
  });

  it('get() after connection drop returns cache miss, not a throw', async () => {
    // First establish a successful write
    await store.set('k', 'v');
    // Connection drops
    fake.setState('unavailable');
    // Now the get should degrade gracefully
    await expect(store.get('k')).resolves.toBeUndefined();
  });

  it('set() after connection drop does not throw', async () => {
    await store.set('k', 'v');
    fake.setState('unavailable');
    await expect(store.set('k', 'new-value')).resolves.toBeUndefined();
  });

  it('del() after connection drop does not throw', async () => {
    await store.set('k', 'v');
    fake.setState('unavailable');
    await expect(store.del('k')).resolves.toBeUndefined();
  });

  it('has() after connection drop returns false (does not throw)', async () => {
    await store.set('k', 'v');
    fake.setState('unavailable');
    await expect(store.has('k')).resolves.toBe(false);
  });

  it('deleteByPrefix after connection drop does not throw', async () => {
    await store.set('players:list:1', []);
    fake.setState('unavailable');
    await expect(store.deleteByPrefix('players:list')).resolves.toBeUndefined();
  });

  it('get() after connection drop completes within bounded time', async () => {
    await store.set('k', 'v');
    fake.setState('unavailable');
    const result = await withTimeout(store.get('k'), BOUND_MS);
    expect(result.timedOut).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Redis command timeout
// ─────────────────────────────────────────────────────────────────────────────

describe('RedisCacheStore — Redis command timeout', () => {
  let fake: FakeRedisStore;
  let store: RedisCacheStore;

  beforeEach(() => {
    ({ fake, store } = makeStore());
    fake.setState('timeout');
  });

  afterEach(() => {
    // Reject all pending to clean up dangling promises before the fake flushes
    fake.rejectAllPending(new RedisConnectionError('cleanup'));
    fake.flush();
  });

  it('get() recovers when the timeout fires — returns cache miss', async () => {
    // Start the operation in timeout state
    const getPromise = store.get('k');
    // Simulate the timeout firing (analogous to ioredis commandTimeout)
    fake.rejectAllPending(new Error('command timeout'));
    // The store should catch the rejection and return undefined
    await expect(getPromise).resolves.toBeUndefined();
  });

  it('set() recovers when the timeout fires — no throw', async () => {
    const setPromise = store.set('k', 'v');
    fake.rejectAllPending(new Error('command timeout'));
    await expect(setPromise).resolves.toBeUndefined();
  });

  it('del() recovers when the timeout fires — no throw', async () => {
    const delPromise = store.del('k');
    fake.rejectAllPending(new Error('command timeout'));
    await expect(delPromise).resolves.toBeUndefined();
  });

  it('has() recovers when the timeout fires — returns false', async () => {
    const hasPromise = store.has('k');
    fake.rejectAllPending(new Error('command timeout'));
    await expect(hasPromise).resolves.toBe(false);
  });

  it('get() completes within bounded time after timeout rejection', async () => {
    const getPromise = store.get('k');
    // Immediately reject pending (simulates short commandTimeout firing)
    fake.rejectAllPending(new Error('command timeout'));
    const result = await withTimeout(getPromise, BOUND_MS);
    expect(result.timedOut).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Recovery — Redis becomes healthy after a failure period
// ─────────────────────────────────────────────────────────────────────────────

describe('RedisCacheStore — Redis recovery', () => {
  let fake: FakeRedisStore;
  let store: RedisCacheStore;

  beforeEach(() => {
    ({ fake, store } = makeStore());
  });

  afterEach(() => {
    fake.flush();
  });

  it('resumes normal operation after recovering from unavailable state', async () => {
    // Write data while healthy
    await store.set('players:1', { name: 'Alice' });

    // Connection drops — get returns cache miss
    fake.setState('unavailable');
    await expect(store.get('players:1')).resolves.toBeUndefined();

    // Connection recovers — data is still in store, readable again
    fake.setState('healthy');
    await expect(store.get('players:1')).resolves.toEqual({ name: 'Alice' });
  });

  it('can write new data after recovering', async () => {
    fake.setState('unavailable');
    // Write fails silently
    await store.set('k', 'v');

    fake.setState('healthy');
    // Fresh write succeeds
    await store.set('k2', 'v2');
    await expect(store.get('k2')).resolves.toBe('v2');
  });

  it('completes within bounded time after recovery', async () => {
    fake.setState('unavailable');
    fake.setState('healthy');
    const result = await withTimeout(store.get('k'), BOUND_MS);
    expect(result.timedOut).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Cache failure semantics
// ─────────────────────────────────────────────────────────────────────────────

describe('RedisCacheStore — failure semantics', () => {
  it('Redis failure on get is treated as a cache miss, not an application error', async () => {
    const { fake, store } = makeStore();
    fake.setState('unavailable');

    // Verify the method resolves (does not reject) — caller code that does
    // `const val = await store.get('k'); if (!val) { fetchFresh... }`
    // will take the cache-miss path safely.
    const val = await store.get<{ name: string }>('players:1');
    expect(val).toBeUndefined();
    fake.flush();
  });

  it('Redis failure on set does not throw — write is silently skipped', async () => {
    const { fake, store } = makeStore();
    fake.setState('unavailable');

    // This must not throw; callers do not wrap cacheSet in try/catch
    await expect(store.set('players:1', { name: 'Alice' })).resolves.toBeUndefined();
    fake.flush();
  });

  it('Redis failure on deleteByPrefix does not throw — invalidation is skipped', async () => {
    const { fake, store } = makeStore();
    fake.setState('unavailable');

    await expect(store.deleteByPrefix('players:list')).resolves.toBeUndefined();
    fake.flush();
  });

  it('Redis error is not leaked to API clients — caught internally', async () => {
    // Verify that errors are caught by verifying the method always resolves
    const { fake, store } = makeStore();
    fake.setState('unavailable');

    const results = await Promise.allSettled([
      store.get('k'),
      store.set('k', 'v'),
      store.del('k'),
      store.has('k'),
      store.deleteByPrefix('players:'),
    ]);

    for (const r of results) {
      expect(r.status).toBe('fulfilled');
    }

    fake.flush();
  });
});
