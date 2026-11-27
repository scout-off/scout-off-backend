import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { incLegacyAdminCall } from './metrics';

/** Proposed migration deadline; update via a reviewed release plan before deployment. */
export const LEGACY_ADMIN_SUNSET = 'Wed, 30 Jun 2027 00:00:00 GMT';
export const LEGACY_ADMIN_DEPRECATION = '@1795392000'; // 2026-11-23 UTC, RFC 9745

/** Send deprecation headers even when later auth, validation or caching denies the request. */
export function legacyAdminRoute(route: 'fees' | 'indexer_reindex') {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.set('Deprecation', LEGACY_ADMIN_DEPRECATION);
    res.set('Sunset', LEGACY_ADMIN_SUNSET);
    incLegacyAdminCall(route);
    next();
  };
}

/** Only the retired fees endpoint accepts the legacy X-Idempotency-Key spelling. */
export function legacyFeeIdempotencyKey(req: Request, res: Response, next: NextFunction): void {
  const standard = req.headers['idempotency-key'];
  const alternate = req.headers['x-idempotency-key'];
  if (alternate !== undefined) {
    if (typeof alternate !== 'string' || (standard !== undefined && standard !== alternate)) {
      res.status(400).json({ success: false, error: 'Conflicting idempotency headers' });
      return;
    }
    req.headers['idempotency-key'] = alternate;
  }
  if (
    typeof req.headers['idempotency-key'] !== 'string' ||
    !req.headers['idempotency-key'].trim()
  ) {
    incLegacyAdminCall('fees_missing_key');
    logger.warn(
      '[deprecation] POST /api/admin/fees called without an idempotency key; migrate to /api/admin/fees/withdraw',
    );
  }
  next();
}

/** Compatibility: legacy reindex body had only fromLedger; constrain to 10,000 ledgers. */
export function normalizeLegacyReindex(req: Request, res: Response, next: NextFunction): void {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    next();
    return;
  }
  if (
    body.toLedger === undefined &&
    typeof body.fromLedger === 'number' &&
    Number.isSafeInteger(body.fromLedger) &&
    body.fromLedger >= 0
  ) {
    const toLedger = body.fromLedger + 10_000;
    if (!Number.isSafeInteger(toLedger)) {
      res
        .status(400)
        .json({ success: false, error: 'Ledger range exceeds safe integer precision' });
      return;
    }
    req.body = { ...body, toLedger };
  }
  next();
}
