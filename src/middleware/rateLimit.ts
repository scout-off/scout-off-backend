import { Request, Response, NextFunction } from 'express';
import config from '../config';

interface RateLimitOptions {
  windowMs?: number; // time window in ms (default: config.rateLimit.windowMs)
  max?: number;      // max requests per window per IP (default: config.rateLimit.max)
}

/**
 * Simple in-process IP-based rate limiter.
 * Configurable via windowMs and max; excess requests return HTTP 429.
 *
 * Sets standard rate-limit headers on every response:
 *   X-RateLimit-Limit     — maximum requests allowed in the window
 *   X-RateLimit-Remaining — requests remaining in the current window
 *   X-RateLimit-Reset     — Unix timestamp (seconds) when the window resets
 *
 * On 429 responses also sets:
 *   Retry-After           — seconds until the window resets
 */
export function rateLimit(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? config.rateLimit.windowMs;
  const max = options.max ?? config.rateLimit.max;
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!config.rateLimit.enabled) {
      next();
      return;
    }

    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    let entry = hits.get(ip);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 1, resetAt: now + windowMs };
      hits.set(ip, entry);
    } else {
      entry.count += 1;
    }

    const resetAtSecs = Math.ceil(entry.resetAt / 1000);
    const remaining = Math.max(0, max - entry.count);

    // Standard headers on every response
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(resetAtSecs));

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ success: false, error: 'Too many requests, please try again later' });
      return;
    }

    next();
  };
}
