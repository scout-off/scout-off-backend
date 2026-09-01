/**
 * Reusable Redis failure-mode test harness.
 *
 * ## Strategy: controlled fake transport (Option B)
 *
 * A real Docker Redis instance is not available in this CI/CD environment,
 * and ioredis-mock only simulates normal operation — it cannot simulate
 * ECONNREFUSED, command timeouts, or mid-session connection drops.
 *
 * Instead, this harness builds a lightweight fake that implements the
 * `RedisLike` interface (for cache tests) and a minimal ioredis `eval`
 * surface (for rate-limit tests) and can be programmatically transitioned
 * between states:
 *
 *   HEALTHY  →  UNAVAILABLE  →  RECOVERING  →  HEALTHY
 *
 * Each state change is deterministic (no arbitrary sleeps) and takes effect
 * synchronously on the next call.
 *
 * For rate-limit tests, a separate `FakeRedisClient` class extends
 * `EventEmitter` and mimics enough of the ioredis `Redis` surface to exercise
 * `RedisRateLimitStore` and the `rateLimit` middleware end-to-end.
 *
 * ## Why this is realistic enough
 *
 * The goal is to verify *application behavior* on Redis failure, not to
 * reproduce the exact ioredis internals.  What matters is:
 *
 * 1. When a Redis call rejects, does the cache layer degrade gracefully?
 * 2. When a Redis call hangs (simulated by a never-resolving promise), does
 *    the application's commandTimeout eventually reject it?
 * 3. After recovery, do subsequent calls succeed again?
 *
 * The fake achieves all three without a real network connection.
 */

import { EventEmitter } from 'events';
import { RedisLike } from '../../src/services/redisCacheStore';

// ─── State machine ───────────────────────────────────────────────────────────

export type HarnessState = 'healthy' | 'unavailable' | 'timeout';

/**
 * The error thrown when the harness is in `unavailable` state.
 * Mimics the ioredis ECONNREFUSED / connection-lost error.
 */
export class RedisConnectionError extends Error {
  constructor(message = 'Redis connection refused') {
    super(message);
    this.name = 'RedisConnectionError';
  }
}

// ─── FakeRedisStore ───────────────────────────────────────────────────────────

/**
 * A minimal in-memory Redis store that implements `RedisLike` and supports
 * deterministic failure injection.
 *
 * Usage in tests:
 *
 * ```ts
 * const fake = new FakeRedisStore();
 * const store = new RedisCacheStore(fake);
 *
 * // Normal operation
 * await store.set('key', 'value');
 *
 * // Simulate connection refusal
 * fake.setState('unavailable');
 * await expect(store.get('key')).resolves.toBeUndefined(); // graceful miss
 *
 * // Recover
 * fake.setState('healthy');
 * await expect(store.get('key')).resolves.toBe('value');
 * ```
 */
export class FakeRedisStore implements RedisLike {
  private state: HarnessState = 'healthy';
  private data = new Map<string, string>();
  private ttls = new Map<string, NodeJS.Timeout>();
  /** Resolved when `setState('healthy')` is called (used by timeout tests). */
  private pendingTimeouts: Array<{ reject: (err: Error) => void }> = [];

  setState(state: HarnessState): void {
    this.state = state;
    if (state === 'healthy') {
      // Nothing to do — new calls will succeed immediately.
    }
  }

  getState(): HarnessState {
    return this.state;
  }

  /** Clear all stored data (call in beforeEach). */
  flush(): void {
    for (const timer of this.ttls.values()) clearTimeout(timer);
    this.data.clear();
    this.ttls.clear();
    this.state = 'healthy';
  }

  private maybeReject<T>(): Promise<T> | null {
    if (this.state === 'unavailable') {
      return Promise.reject(new RedisConnectionError());
    }
    if (this.state === 'timeout') {
      // Return a promise that never resolves, simulating a hung Redis command.
      // In production the ioredis `commandTimeout` would reject this after 2s.
      // Tests that use this state should either:
      //   (a) configure a real commandTimeout and measure wall-clock time, or
      //   (b) call resolveTimeout() to unblock deterministically.
      return new Promise<T>((_resolve, reject) => {
        this.pendingTimeouts.push({ reject });
      });
    }
    return null;
  }

  /**
   * Forcibly reject all pending timeout promises.
   * Use this in tests to deterministically unblock a 'timeout' state without
   * waiting for a real timer.
   */
  rejectAllPending(err: Error = new RedisConnectionError('command timeout')): void {
    for (const { reject } of this.pendingTimeouts) {
      reject(err);
    }
    this.pendingTimeouts = [];
  }

  async get(key: string): Promise<string | null> {
    const rejection = this.maybeReject<string | null>();
    if (rejection) return rejection;
    return this.data.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
    const rejection = this.maybeReject<'OK'>();
    if (rejection) return rejection;

    // Support `SET key value PX ttlMs`
    const pxIndex = (args as string[]).findIndex(
      (a) => typeof a === 'string' && a.toUpperCase() === 'PX'
    );
    if (pxIndex !== -1) {
      const ttlMs = Number(args[pxIndex + 1]);
      // Clear any existing TTL timer
      const existing = this.ttls.get(key);
      if (existing) clearTimeout(existing);
      // Schedule expiry
      const timer = setTimeout(() => {
        this.data.delete(key);
        this.ttls.delete(key);
      }, ttlMs);
      // Prevent the timer from blocking Jest exit
      if (timer.unref) timer.unref();
      this.ttls.set(key, timer);
    }

    this.data.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const rejection = this.maybeReject<number>();
    if (rejection) return rejection;
    const existed = this.data.has(key);
    this.data.delete(key);
    const timer = this.ttls.get(key);
    if (timer) {
      clearTimeout(timer);
      this.ttls.delete(key);
    }
    return existed ? 1 : 0;
  }

  async exists(key: string): Promise<number> {
    const rejection = this.maybeReject<number>();
    if (rejection) return rejection;
    return this.data.has(key) ? 1 : 0;
  }

  async scan(
    cursor: string,
    _matchKeyword: string,
    pattern: string,
    _countKeyword: string,
    _count: number
  ): Promise<[string, string[]]> {
    const rejection = this.maybeReject<[string, string[]]>();
    if (rejection) return rejection;
    // Simple full scan (no cursor iteration needed for test volumes)
    if (cursor !== '0') return ['0', []];
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    const keys = [...this.data.keys()].filter((k) => k.startsWith(prefix));
    return ['0', keys];
  }

  pipeline(): FakeRedisPipeline {
    return new FakeRedisPipeline(this);
  }
}

/** Minimal pipeline stub used by `deleteByPrefix`. */
class FakeRedisPipeline {
  private ops: Array<() => Promise<unknown>> = [];

  constructor(private store: FakeRedisStore) {}

  del(key: string): this {
    this.ops.push(() => this.store.del(key));
    return this;
  }

  async exec(): Promise<Array<[Error | null, unknown]>> {
    const results: Array<[Error | null, unknown]> = [];
    for (const op of this.ops) {
      try {
        const val = await op();
        results.push([null, val]);
      } catch (err) {
        results.push([err as Error, null]);
      }
    }
    return results;
  }
}

// ─── FakeRedisClient (for rate-limit middleware tests) ────────────────────────

/**
 * A minimal fake that mimics the ioredis `Redis` surface used by
 * `RedisRateLimitStore` (`eval` only).  Extends `EventEmitter` so the
 * rate-limit middleware can attach an `error` listener if needed.
 */
export class FakeRedisClient extends EventEmitter {
  private state: HarnessState = 'healthy';
  /** key → { count, resetAt } */
  private counters = new Map<string, { count: number; resetAt: number }>();

  setState(state: HarnessState): void {
    this.state = state;
  }

  flush(): void {
    this.counters.clear();
    this.state = 'healthy';
  }

  /**
   * Minimal `eval` implementation supporting the INCR+PEXPIRE Lua script used
   * by `RedisRateLimitStore`.
   */
  async eval(
    _script: string,
    _numKeys: number,
    redisKey: string,
    windowMs: number
  ): Promise<[number, number]> {
    if (this.state === 'unavailable') {
      throw new RedisConnectionError();
    }
    if (this.state === 'timeout') {
      // Never resolves — simulates a hung Redis command.
      return new Promise<[number, number]>((_resolve, _reject) => {
        // intentionally never resolved
      });
    }

    const now = Date.now();
    const existing = this.counters.get(redisKey);

    if (!existing || now >= existing.resetAt) {
      const entry = { count: 1, resetAt: now + Number(windowMs) };
      this.counters.set(redisKey, entry);
      return [1, Number(windowMs)];
    }

    existing.count += 1;
    const ttl = existing.resetAt - now;
    return [existing.count, ttl];
  }
}

// ─── Timing utilities ─────────────────────────────────────────────────────────

/**
 * Returns a promise that resolves after `ms` milliseconds.
 * Prefer deterministic state transitions over sleep() in tests.
 * Only use sleep() when verifying wall-clock time bounds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Race a promise against a timeout.
 *
 * Resolves with `{ timedOut: false, value }` when the promise settles before
 * `ms`, or `{ timedOut: true }` when the timeout fires first.
 *
 * Use this to assert that an operation completes within a bounded time:
 *
 * ```ts
 * const result = await withTimeout(store.get('key'), 500);
 * expect(result.timedOut).toBe(false);
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    if (timer.unref) timer.unref();
  });

  try {
    const value = await Promise.race([
      promise.then((v): { timedOut: false; value: T } => ({ timedOut: false, value: v })),
      timeout,
    ]);
    return value;
  } finally {
    clearTimeout(timer!);
  }
}
