/**
 * Tests for cache hit/miss/eviction metrics (issue #728).
 *
 * Verifies that:
 *   1. cacheGet() increments the hit counter on a cache hit.
 *   2. cacheGet() increments the miss counter on a cache miss.
 *   3. InMemoryCacheStore increments the eviction counter when a key is
 *      found but has already expired (lazy eviction path).
 *   4. The counters are exposed in the Prometheus /metrics output alongside
 *      other tracked metrics.
 */

import {
  resetMetrics,
  getCacheMetrics,
  recordCacheHit,
  recordCacheMiss,
  recordCacheEviction,
  recordCacheInvalidation,
  getCacheInvalidationTotal,
  serializeMetrics,
} from '../../src/middleware/metrics';
import { InMemoryCacheStore } from '../../src/services/inMemoryCacheStore';
import * as cacheModule from '../../src/services/cache';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => resetMetrics());

// ---------------------------------------------------------------------------
// Counter primitives
// ---------------------------------------------------------------------------

describe('cache metric counter primitives', () => {
  it('recordCacheHit() increments the hits counter', () => {
    recordCacheHit();
    recordCacheHit();
    expect(getCacheMetrics().hits).toBe(2);
  });

  it('recordCacheMiss() increments the misses counter', () => {
    recordCacheMiss();
    expect(getCacheMetrics().misses).toBe(1);
  });

  it('recordCacheEviction() increments the evictions counter', () => {
    recordCacheEviction();
    recordCacheEviction();
    expect(getCacheMetrics().evictions).toBe(2);
  });

  it('counters start at zero after resetMetrics()', () => {
    recordCacheHit();
    recordCacheMiss();
    recordCacheEviction();
    resetMetrics();
    const counts = getCacheMetrics();
    expect(counts.hits).toBe(0);
    expect(counts.misses).toBe(0);
    expect(counts.evictions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cacheGet() in the public cache API
// ---------------------------------------------------------------------------

describe('cacheGet() increments hit/miss counters', () => {
  beforeEach(() => {
    resetMetrics();
  });

  it('increments hit counter when the key exists', async () => {
    await cacheModule.cacheSet('players:1', { name: 'Alice' });
    await cacheModule.cacheGet('players:1');
    expect(getCacheMetrics().hits).toBe(1);
    expect(getCacheMetrics().misses).toBe(0);
  });

  it('increments miss counter when the key does not exist', async () => {
    await cacheModule.cacheGet('players:nonexistent');
    expect(getCacheMetrics().misses).toBe(1);
    expect(getCacheMetrics().hits).toBe(0);
  });

  it('increments counters independently across multiple calls', async () => {
    await cacheModule.cacheSet('players:hit', { name: 'Bob' });
    await cacheModule.cacheGet('players:hit');   // hit
    await cacheModule.cacheGet('players:hit');   // hit
    await cacheModule.cacheGet('players:miss');  // miss
    expect(getCacheMetrics().hits).toBe(2);
    expect(getCacheMetrics().misses).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// InMemoryCacheStore lazy eviction path
// ---------------------------------------------------------------------------

describe('InMemoryCacheStore increments eviction counter on expired key read', () => {
  it('records an eviction when a key is read after its TTL has elapsed', async () => {
    const store = new InMemoryCacheStore();

    // Set a key with a 1 ms TTL so it expires immediately.
    await store.set('expiring-key', 'value', 1);

    // Wait long enough for the TTL to elapse.
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Reading the expired key should trigger a lazy eviction.
    const result = await store.get<string>('expiring-key');
    expect(result).toBeUndefined();
    expect(getCacheMetrics().evictions).toBe(1);
  });

  it('does NOT record an eviction for a key that was never set', async () => {
    const store = new InMemoryCacheStore();
    const result = await store.get<string>('never-set');
    expect(result).toBeUndefined();
    expect(getCacheMetrics().evictions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// cache_invalidation_total counter (#763)
// ---------------------------------------------------------------------------

describe('cache_invalidation_total counter', () => {
  it('recordCacheInvalidation() increments the counter', () => {
    recordCacheInvalidation();
    recordCacheInvalidation();
    expect(getCacheInvalidationTotal()).toBe(2);
  });

  it('counter starts at zero after resetMetrics()', () => {
    recordCacheInvalidation();
    resetMetrics();
    expect(getCacheInvalidationTotal()).toBe(0);
  });

  it('invalidatePlayerCache() increments the counter once per invalidation', async () => {
    await cacheModule.invalidatePlayerCache();
    expect(getCacheInvalidationTotal()).toBe(1);
    await cacheModule.invalidatePlayerCache('p1');
    expect(getCacheInvalidationTotal()).toBe(2);
  });

  it('serializeMetrics() exposes cache_invalidation_total with HELP/TYPE lines', () => {
    recordCacheInvalidation();
    const output = serializeMetrics();
    expect(output).toContain('cache_invalidation_total 1');
    expect(output).toContain('# HELP cache_invalidation_total');
    expect(output).toContain('# TYPE cache_invalidation_total counter');
  });

  it('emits zero when no invalidations have occurred', () => {
    const output = serializeMetrics();
    expect(output).toContain('cache_invalidation_total 0');
  });
});

// ---------------------------------------------------------------------------
// Prometheus serialisation
// ---------------------------------------------------------------------------

describe('serializeMetrics() includes cache counters', () => {
  it('emits cache_hits_total, cache_misses_total, and cache_evictions_total', () => {
    recordCacheHit();
    recordCacheHit();
    recordCacheMiss();
    recordCacheEviction();

    const output = serializeMetrics();
    expect(output).toContain('cache_hits_total 2');
    expect(output).toContain('cache_misses_total 1');
    expect(output).toContain('cache_evictions_total 1');
  });

  it('includes HELP and TYPE lines for each cache counter', () => {
    const output = serializeMetrics();
    expect(output).toContain('# HELP cache_hits_total');
    expect(output).toContain('# TYPE cache_hits_total counter');
    expect(output).toContain('# HELP cache_misses_total');
    expect(output).toContain('# TYPE cache_misses_total counter');
    expect(output).toContain('# HELP cache_evictions_total');
    expect(output).toContain('# TYPE cache_evictions_total counter');
  });

  it('emits zero values when no cache operations have occurred', () => {
    const output = serializeMetrics();
    expect(output).toContain('cache_hits_total 0');
    expect(output).toContain('cache_misses_total 0');
    expect(output).toContain('cache_evictions_total 0');
  });
});
