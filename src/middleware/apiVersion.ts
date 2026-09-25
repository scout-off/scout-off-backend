/**
 * apiVersion middleware
 *
 * Sets the served API version on every response as two headers:
 *
 *   API-Version: <major>          ← canonical header
 *   X-API-Version: <major>        ← deprecated alias; will be removed in v3
 *
 * Both headers always carry the same value so clients that have not yet
 * migrated from `X-API-Version` continue to work without seeing a
 * disagreement.
 *
 * Canonical header: `API-Version`
 * Deprecated alias: `X-API-Version` — clients should migrate to `API-Version`.
 *   The alias will be removed when the v1 sunset is scheduled (see
 *   docs/api-versioning.md §Deprecation policy).
 *
 * Version determination (highest precedence first):
 *   1. Explicit URL prefix  — /api/v2/... → 2, /api/v1/... → 1
 *   2. req.apiVersionOverride — set by versionRouting.ts from the
 *      `API-Version` request header (e.g. `API-Version: 2`)
 *   3. Default              — any other path → 1
 *
 * Applied globally in app.ts before route handlers so every response —
 * including health-check, metrics, and auth endpoints — carries both headers.
 */

import { Request, Response, NextFunction } from 'express';
import { API_V2_PREFIX, API_V1_PREFIX } from '../config';

/**
 * Determine the API major version that will serve this request.
 * Returns 2 for /api/v2 paths or requests with apiVersionOverride === 2,
 * otherwise returns 1.
 */
function resolveServedVersion(req: Request): number {
  const url = req.originalUrl;
  if (
    url.startsWith(API_V2_PREFIX + '/') ||
    url === API_V2_PREFIX ||
    req.apiVersionOverride === 2
  ) {
    return 2;
  }
  // Explicit /api/v1/... is version 1; so is every other path.
  return 1;
}

export function apiVersion(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const version = String(resolveServedVersion(req));
  // Canonical header — clients should read this one.
  res.setHeader('API-Version', version);
  // Deprecated alias — same value; kept for backward compatibility.
  res.setHeader('X-API-Version', version);
  next();
}
