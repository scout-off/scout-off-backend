/**
 * versionRouting middleware
 *
 * Reads an `API-Version: 2` request header as an alternative to the /api/v2
 * URL prefix and rewrites req.versionOverride so the router in app.ts can
 * delegate to the correct handler set.
 *
 * Also emits a deprecation warning at `warn` level whenever an unversioned
 * /api/ path (i.e. not /api/v1 or /api/v2) is called in production.
 *
 * Applied globally in app.ts before the versioned route mounts.
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import config from '../config';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Explicit API version requested via the API-Version header (e.g. 1 or 2). */
      apiVersionOverride?: number;
    }
  }
}

/**
 * Parse the API-Version request header.
 * Returns the integer version if present and valid (1 or 2), otherwise null.
 */
function parseApiVersionHeader(req: Request): number | null {
  const raw = req.headers['api-version'];
  if (!raw || typeof raw !== 'string') return null;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 1) return n;
  return null;
}

export function versionRouting(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // ── Header-based version override ─────────────────────────────────────────
  const headerVersion = parseApiVersionHeader(req);
  if (headerVersion !== null) {
    req.apiVersionOverride = headerVersion;
  }

  // ── Deprecation warning for bare /api/ paths in production ───────────────
  if (
    config.nodeEnv === 'production' &&
    req.path.startsWith('/') &&
    // The request came in on /api/... (not /api/v1/... or /api/v2/...)
    // We can detect this by checking the original URL prefix.
    req.originalUrl.startsWith('/api/') &&
    !req.originalUrl.startsWith('/api/v1/') &&
    !req.originalUrl.startsWith('/api/v2/')
  ) {
    logger.warn(
      `[deprecation] Unversioned /api/ path called: ${req.method} ${req.originalUrl} — ` +
        'prefer /api/v1/ or /api/v2/. Unversioned paths will be removed in a future release.',
    );
  }

  next();
}
