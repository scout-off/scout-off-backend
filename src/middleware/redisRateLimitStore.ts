import Redis from 'ioredis';
import { RateLimitStore } from './rateLimitStore';
import { logger } from '../utils/logger';

/**
 * ## Fail-open policy
 *
 * When Redis is unavailable, `increment` throws an error.  The `rateLimit`
 * middleware catches that error and calls `next(err)`, which currently
 * results in a 500 response (fail-closed).
 *
 * This store does NOT swallow the error itself — that would hide the failure
 * from operators.  Instead, it is the responsibility of the *middleware* layer
 * to decide whether a Redis failure should fail open (allow the request) or
 * fail closed (reject with 500).
 *
 * See `src/middleware/rateLimit.ts` for the current fail-open decision.
 *
 * ## Bounded latency
 *
 * Redis command timeouts are configured on the shared ioredis client
 * (`commandTimeout: 2000` in `src/services/redis.ts`), so a hung Redis
 * connection will not cause `increment` to block indefinitely.
 */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(private client: Redis) {}

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const redisKey = `rate-limit:${key}`;

    // Use a Lua script to ensure atomicity of INCR and conditional PEXPIRE.
    // It returns the new count and the current TTL in milliseconds.
    const script = `
      local count = redis.call("INCR", KEYS[1])
      if count == 1 then
        redis.call("PEXPIRE", KEYS[1], ARGV[1])
      end
      local ttl = redis.call("PTTL", KEYS[1])
      return {count, ttl}
    `;

    try {
      const result = await this.client.eval(script, 1, redisKey, windowMs) as [number, number];
      const count = result[0];
      const ttl = result[1] > 0 ? result[1] : windowMs;
      const resetAt = Date.now() + ttl;

      return { count, resetAt };
    } catch (err) {
      // Log and re-throw — the rate-limit middleware is responsible for
      // deciding how to handle the failure (fail-open or fail-closed).
      logger.warn('[rate-limit] Redis increment failed', { key, err });
      throw err;
    }
  }
}
