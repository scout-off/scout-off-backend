import { Request, Response, NextFunction } from 'express';
import config from '../config';
import { RateLimitStore } from './rateLimitStore';
import { InMemoryRateLimitStore } from './inMemoryRateLimitStore';
import { RedisRateLimitStore } from './redisRateLimitStore';
import { getRedisClient } from '../services/redis';

function createStore(): RateLimitStore {
  const redis = getRedisClient();
  if (redis) {
    return new RedisRateLimitStore(redis);
  }
  return new InMemoryRateLimitStore();
}

const defaultStore: RateLimitStore = createStore();

export interface RateLimitOptions {
  windowMs?: number; // time window in ms (default: config.rateLimit.windowMs)
  max?: number;      // max requests per window per IP (default: config.rateLimit.max)
  store?: RateLimitStore; // override default store (useful for tests)
  /**
   * Namespace distinguishing this limiter's counters from every other
   * rateLimit() instance sharing the same default store. Without this,
   * two differently-configured limiters (e.g. auth vs. milestone
   * submission) would increment the exact same `ip:<ip>` counter and
   * enforce whichever limiter's `max` is lowest against ALL of that IP's
   * traffic, not just the traffic for that specific limiter. Defaults to
   * 'default' for backward compatibility with any caller that doesn't need
   * isolation from other limiters.
   */
  name?: string;
}

/**
 * Simple in-process or Redis-backed IP-based rate limiter.
 * Configurable via windowMs and max; excess requests return HTTP 429.
 */
export function rateLimit(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? config.rateLimit.windowMs;
  const max = options.max ?? config.rateLimit.max;
  const store = options.store ?? defaultStore;
  const namespace = options.name ?? 'default';

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!config.rateLimit.enabled) {
      next();
      return;
    }
    const ip = req.ip ?? 'unknown';

    try {
      const { count, resetAt } = await store.increment(`${namespace}:ip:${ip}`, windowMs);

      if (count > max) {
        const now = Date.now();
        const retryAfterSec = Math.ceil(Math.max(0, resetAt - now) / 1000);
        res.set('Retry-After', String(retryAfterSec || 1));
        res.status(429).json({ success: false, error: 'Too many requests, please try again later' });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Simple in-process or Redis-backed wallet-based rate limiter.
 * Configurable via windowMs and max; excess requests return HTTP 429.
 * If req.account is not present, it calls next().
 */
export function walletRateLimit(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? config.rateLimit.windowMs;
  const max = options.max ?? config.rateLimit.max;
  const store = options.store ?? defaultStore;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!config.rateLimit.enabled) {
      next();
      return;
    }
    const wallet = req.account;
    if (!wallet) {
      next();
      return;
    }

    try {
      const { count } = await store.increment(`wallet:${wallet}`, windowMs);

      if (count > max) {
        res.status(429).json({ success: false, error: 'Too many requests, please try again later' });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
