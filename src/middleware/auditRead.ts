import { NextFunction, Request, Response } from 'express';
import config from '../config';
import { logAuditEvent } from '../services/audit';
import { logger } from '../utils/logger';
import { getCorrelationId } from '../utils/requestContext';

/**
 * Audit-log reads of sensitive data (#1531).
 *
 * The hash-chained audit log records mutations and auth failures, but not who
 * viewed sensitive data (audit trail, exports, encrypted notes, API-key
 * listings). This middleware records one audit entry per successful (2xx)
 * response, containing the actor, role, target and correlation id — never the
 * response body or query string, so no PII or secrets are copied into the
 * audit log.
 *
 * Writes happen after `finish`, best-effort: a failed audit insert must not
 * fail a request that was already served, and a 4xx/5xx response is not a
 * successful read and is therefore not recorded.
 */

export type AuditReadTarget = (req: Request) => string | undefined;

/**
 * @param action  Short action name; stored as `read:<action>`.
 * @param target  Optional function deriving the object that was read.
 */
export function auditRead(
  action: string,
  target?: AuditReadTarget,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    if (!config.auditReads.enabled) {
      next();
      return;
    }

    // Capture request-scoped values now; the AsyncLocalStorage context may not
    // be active by the time the response finishes.
    const actor = req.account ?? null;
    const role = req.role ?? null;
    const correlationId = getCorrelationId() ?? null;
    const targetValue = target ? target(req) : undefined;
    const method = req.method;
    const path = req.originalUrl.split('?')[0];
    const ip = req.ip;

    res.once('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;

      void logAuditEvent({
        action: `read:${action}`,
        timestamp: new Date().toISOString(),
        adminWallet: actor ?? 'unknown',
        queryParams: {
          actor,
          role,
          target: targetValue ?? null,
          correlationId,
          method,
          path,
          ip,
        },
      }).catch((err: unknown) => {
        logger.warn('[audit-read] failed to record sensitive read', {
          action: `read:${action}`,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    next();
  };
}
