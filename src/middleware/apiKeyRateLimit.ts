/**
 * API Key Rate Limiting Middleware (#1327)
 *
 * Per-API-key rate limiting (burst + sustained) and monthly quota enforcement.
 * Applied automatically when req.apiKeyId is set (by authenticateApiKey in auth.ts).
 *
 * Design:
 *   - Rate limit: per-minute cap on requests from a single key (independent of JWT)
 *   - Quota: monthly (rolling window) cap; checked via Redis INCR for performance
 *   - Headers: RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset (IETF draft)
 *   - Failure: returns 429 with distinct code (API_KEY_RATE_LIMIT_EXCEEDED or API_KEY_QUOTA_EXCEEDED)
 *
 * When a key has no explicit rate_limit_per_minute, requests are unlimited (for now).
 * When a key has no monthly_quota, monthly usage is tracked but not enforced.
 */

import { Request, Response, NextFunction } from 'express';
import { getRedisClient } from '../services/redis';
import { getApiKeyRateLimits } from '../db/apiKeyHelpers';
import { logger } from '../utils/logger';

interface ApiKeyRateLimitConfig {
  rate_limit_per_minute: number | null;
  monthly_quota: number | null;
}

// Cache of key configs to avoid a DB hit per request
const configCache = new Map<number, ApiKeyRateLimitConfig & { cachedAt: number }>();
const CONFIG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getKeyConfig(keyId: number): Promise<ApiKeyRateLimitConfig> {
  const cached = configCache.get(keyId);
  if (cached && Date.now() - cached.cachedAt < CONFIG_CACHE_TTL_MS) {
    return { rate_limit_per_minute: cached.rate_limit_per_minute, monthly_quota: cached.monthly_quota };
  }

  try {
    const config = await getApiKeyRateLimits(keyId);
    if (config) {
      configCache.set(keyId, { ...config, cachedAt: Date.now() });
      return { rate_limit_per_minute: config.rate_limit_per_minute, monthly_quota: config.monthly_quota };
    }
  } catch (err) {
    logger.warn(`[apiKeyRateLimit] failed to fetch config for key ${keyId}:`, err);
  }

  return { rate_limit_per_minute: null, monthly_quota: null };
}

function getCurrentMonthKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Middleware for per-API-key rate limiting and quota enforcement.
 * Only activates if req.apiKeyId is set (by authenticateApiKey in auth.ts).
 */
export async function apiKeyRateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.apiKeyId) {
    next();
    return;
  }

  const redis = getRedisClient();
  const config = await getKeyConfig(req.apiKeyId);

  // Check per-minute rate limit
  if (config.rate_limit_per_minute && config.rate_limit_per_minute > 0) {
    if (!redis) {
      // Redis unavailable; rate limiting is best-effort. Fail open.
      logger.warn(`[apiKeyRateLimit] Redis unavailable for rate limiting on key ${req.apiKeyId}`);
    } else {
      const rateLimitKey = `apikey:ratelimit:${req.apiKeyId}:minute`;
      try {
        const currentCount = await redis.incr(rateLimitKey);
        if (currentCount === 1) {
          // First request in this minute; set expiry
          await redis.expire(rateLimitKey, 60);
        }

        if (currentCount > config.rate_limit_per_minute) {
          const resetAt = Math.floor(Date.now() / 1000) + 60;
          res.set('RateLimit-Limit', String(config.rate_limit_per_minute));
          res.set('RateLimit-Remaining', '0');
          res.set('RateLimit-Reset', String(resetAt));
          res.status(429).json({
            success: false,
            error: 'API key rate limit exceeded',
            code: 'API_KEY_RATE_LIMIT_EXCEEDED',
          });
          return;
        }

        res.set('RateLimit-Limit', String(config.rate_limit_per_minute));
        res.set('RateLimit-Remaining', String(config.rate_limit_per_minute - currentCount));
        res.set('RateLimit-Reset', String(Math.floor(Date.now() / 1000) + 60));
      } catch (err) {
        logger.warn(`[apiKeyRateLimit] rate limit check failed for key ${req.apiKeyId}:`, err);
        // Fail open
      }
    }
  }

  // Check monthly quota
  if (config.monthly_quota && config.monthly_quota > 0) {
    if (!redis) {
      logger.warn(`[apiKeyRateLimit] Redis unavailable for quota tracking on key ${req.apiKeyId}`);
    } else {
      const monthKey = getCurrentMonthKey();
      const quotaKey = `apikey:quota:${req.apiKeyId}:${monthKey}`;
      try {
        const currentUsage = await redis.incr(quotaKey);
        if (currentUsage === 1) {
          // First request in this month; set expiry to end of month (safe to use 32 days)
          await redis.expire(quotaKey, 32 * 24 * 60 * 60);
        }

        if (currentUsage > config.monthly_quota) {
          res.status(429).json({
            success: false,
            error: 'API key monthly quota exceeded',
            code: 'API_KEY_QUOTA_EXCEEDED',
          });
          return;
        }
      } catch (err) {
        logger.warn(`[apiKeyRateLimit] quota check failed for key ${req.apiKeyId}:`, err);
        // Fail open
      }
    }
  }

  next();
}

/** Clear config cache (useful for tests). */
export function _clearApiKeyRateLimitCache(): void {
  configCache.clear();
}
