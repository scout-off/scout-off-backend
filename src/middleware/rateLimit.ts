import { Request, Response, NextFunction } from 'express';

interface RateLimitOptions {
  windowMs?: number; // time window in ms (default: 60_000)
  max?: number; // max requests per window per IP (default: 10)
}

/**
 * Simple in-process IP-based rate limiter.
 * Configurable via windowMs and max; excess requests return HTTP 429.
 */
export function rateLimit(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const max = options.max ?? 10;
  const hits = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(ip);

    if (!entry || now >= entry.resetAt) {
      hits.set(ip, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    entry.count += 1;
    if (entry.count > max) {
      res.status(429).json({ success: false, error: 'Too many requests, please try again later' });
      return;
    }
    next();
  };
}
