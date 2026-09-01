/**
 * IP Reputation Middleware
 *
 * An additional security layer on top of the existing rateLimit middleware.
 * Evaluates each request against the IP reputation score and applies
 * progressive penalties:
 *
 *   score 0–49   → normal (no-op)
 *   score 50–74  → degraded — 500 ms response delay before next()
 *   score 75–89  → restricted — rate-limit header injected (5 req/min hint)
 *   score 90–100 → blocked — immediate 429
 *
 * Score increments are applied via helper functions imported from
 * src/services/ipReputation.ts and must be called at the appropriate sites
 * (see the response-finish hook below for error-rate tracking).
 */
import { Request, Response, NextFunction } from 'express';
import config from '../config';
import { extractClientIp } from '../utils/ipExtractor';
import { logger } from '../utils/logger';
import {
  addPoints,
  getTier,
  getScore,
  isBadUserAgent,
  POINTS,
  SCORE_DELAY_THRESHOLD,
  SCORE_RESTRICT_THRESHOLD,
  SCORE_BLOCK_THRESHOLD,
  ipReputationCounters,
} from '../services/ipReputation';

const DELAY_MS = 500;
const RESTRICTED_RATE_LIMIT = 5; // req/min suggestion exposed via header

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Core IP reputation middleware.
 *
 * 1. Extracts the real client IP.
 * 2. Applies bad-UA points on first detection.
 * 3. Blocks, delays, or annotates based on the current score tier.
 * 4. Hooks into res.finish to record error-rate points after the response.
 */
export function ipReputationMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!config.ipReputation.enabled) {
    next();
    return;
  }
  const ip = extractClientIp(req);
  const ua = req.headers['user-agent'];

  // Penalise recognised scanner/attack user agents immediately.
  if (isBadUserAgent(ua)) {
    addPoints(ip, POINTS.BAD_USER_AGENT);
  }

  const score = getScore(ip);
  const tier = getTier(score);

  // Attach finish hook to score errors after the handler responds.
  res.on('finish', () => {
    const status = res.statusCode;
    if (status === 429) {
      addPoints(ip, POINTS.RATE_LIMIT_HIT);
    } else if (status === 401 || status === 403) {
      addPoints(ip, POINTS.AUTH_FAILURE);
    } else if (status >= 500) {
      addPoints(ip, POINTS.ERROR_5XX);
    } else if (status >= 400) {
      addPoints(ip, POINTS.ERROR_4XX);
    }
  });

  if (tier === 'blocked') {
    ipReputationCounters.blocked += 1;
    logger.warn(
      `[ipReputation] blocked ip=${ip} score=${score}`
    );
    res.status(429).json({
      success: false,
      error: 'Too many requests — your IP has been temporarily blocked.',
    });
    return;
  }

  if (tier === 'restricted') {
    ipReputationCounters.penalised += 1;
    // Surface the reduced limit as an advisory header so well-behaved clients
    // can back off. The actual enforcement is still the existing rateLimit
    // middleware — this is guidance only.
    res.setHeader('X-RateLimit-Reputation-Limit', String(RESTRICTED_RATE_LIMIT));
    logger.debug(
      `[ipReputation] restricted ip=${ip} score=${score}`
    );
    next();
    return;
  }

  if (tier === 'degraded') {
    ipReputationCounters.penalised += 1;
    logger.debug(
      `[ipReputation] degraded (delay=${DELAY_MS}ms) ip=${ip} score=${score}`
    );
    // Asynchronous delay — call next() after the sleep so we don't block
    // the Node.js event loop while waiting.
    sleep(DELAY_MS).then(() => next()).catch(() => next());
    return;
  }

  next();
}

/**
 * Convenience export so route handlers can manually signal a rate-limit hit
 * (e.g. from the existing rateLimit middleware) without importing the service
 * directly.
 */
export function recordRateLimitHit(ip: string): void {
  addPoints(ip, POINTS.RATE_LIMIT_HIT);
}

// Re-export score constants so callers only need one import.
export { SCORE_DELAY_THRESHOLD, SCORE_RESTRICT_THRESHOLD, SCORE_BLOCK_THRESHOLD };
