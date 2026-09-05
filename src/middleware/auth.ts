import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JwtPayload } from '../types';
import { sendUnauthorized, sendForbidden } from '../utils/authError';
import { logger } from '../utils/logger';
import { isTokenRevoked } from '../services/tokenBlocklist';
import { logAuditEvent } from '../services/audit';
import { verifyJwt } from '../utils/jwt';
import { hasApiKeyScope, ApiKeyScope } from '../utils/apiKeyScopes';

export interface AuthPayload extends jwt.JwtPayload, Partial<JwtPayload> {}

/** Verify a token against the current secret, then the previous secret (grace window). */
function verifyToken(token: string): AuthPayload {
  return verifyJwt(token) as AuthPayload;
}

/** Shape returned by the API-key controller's resolver. */
interface ResolvedApiKey {
  scout_wallet: string;
  id: number;
  /** Parsed scope list; null = legacy/unrestricted key. */
  scopes: string[] | null;
}

/**
 * Shared X-API-Key authentication used by requireAuth and requireRole.
 *
 * On success attaches req.account / req.role / req.apiKeyScopes and returns
 * 'ok'. On failure sends the appropriate 401/403 response and returns a
 * non-'ok' status so the caller can stop the request.
 *
 * Keeping this in one place guarantees REST and GraphQL (which uses the same
 * resolveApiKey) can never drift apart on API-key semantics (#1019).
 */
export async function authenticateApiKey(
  req: Request,
  res: Response,
  requiredRole?: string,
): Promise<'ok' | 'forbidden' | 'unauthorized'> {
  try {
    // Lazy require avoids a circular module dependency at load time.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveApiKey } = require('../controllers/apiKeyController') as {
      resolveApiKey: (rawKey: string) => Promise<ResolvedApiKey | null>;
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { touchApiKeyLastUsed } = require('../db') as {
      touchApiKeyLastUsed: (id: number) => Promise<void>;
    };
    const resolved = await resolveApiKey(req.headers['x-api-key'] as string);
    if (!resolved) {
      logger.warn({ method: req.method, path: req.path, error: 'Invalid or revoked API key' });
      sendUnauthorized(res, 'Invalid or revoked API key');
      return 'unauthorized';
    }
    if (requiredRole && requiredRole !== 'scout') {
      logger.warn({
        method: req.method,
        path: req.path,
        error: 'Insufficient permissions',
        requiredRole,
        providedRole: 'scout',
      });
      logAuditEvent({ action: 'auth_forbidden', path: req.path, reason: 'Insufficient permissions', requiredRole, timestamp: new Date().toISOString() }).catch(() => {});
      sendForbidden(res, 'Insufficient permissions', { requiredRole, providedRole: 'scout' });
      return 'forbidden';
    }
    Promise.resolve(touchApiKeyLastUsed(resolved.id)).catch(() => { /* best-effort */ });
    req.account = resolved.scout_wallet;
    req.role = 'scout';
    req.apiKeyScopes = resolved.scopes;
    return 'ok';
  } catch {
    logger.warn({ method: req.method, path: req.path, error: 'API key auth error' });
    sendUnauthorized(res, 'Invalid or revoked API key');
    return 'unauthorized';
  }
}

/**
 * Middleware that verifies any valid JWT Bearer token.
 * Attaches `req.account` (Stellar public key) and `req.role` on success.
 * Returns 401 if the token is missing, invalid, expired, or revoked.
 *
 * Also accepts an X-API-Key header as an alternative to a JWT Bearer token.
 * When an X-API-Key is provided and verified, req.account is set to the
 * associated scout wallet, req.role is set to 'scout', and req.apiKeyScopes
 * is set to the key's parsed scopes (null = legacy/unrestricted).
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // ── X-API-Key path ──────────────────────────────────────────────────────────
  const apiKeyHeader = req.headers['x-api-key'];
  if (apiKeyHeader && typeof apiKeyHeader === 'string') {
    if ((await authenticateApiKey(req, res)) !== 'ok') return;
    next();
    return;
  }

  // ── JWT Bearer path ─────────────────────────────────────────────────────────
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    logger.warn({ method: req.method, path: req.path, error: 'Missing auth token' });
    logAuditEvent({ action: 'auth_failed', path: req.path, reason: 'Missing auth token', timestamp: new Date().toISOString() }).catch(() => {});
    sendUnauthorized(res, 'Missing auth token');
    return;
  }
  try {
    const payload = verifyToken(header.slice(7));
    // isTokenRevoked is async; we must chain into a Promise to avoid blocking
    // the event loop while still sending the 401 on the same request lifecycle.
    isTokenRevoked(payload.jti).then((revoked) => {
      if (revoked) {
        logger.warn({ method: req.method, path: req.path, error: 'Token revoked' });
        sendUnauthorized(res, 'Token has been revoked');
        return;
      }
      req.account = payload.sub;
      req.role = payload.role;
      req.jti = payload.jti;
      next();
    }).catch(() => {
      // Revocation check failed — fail open (allow request) to avoid blocking
      // legitimate traffic when the blocklist store is temporarily unavailable.
      logger.warn({ method: req.method, path: req.path, error: 'Revocation check failed, allowing request' });
      req.account = payload.sub;
      req.role = payload.role;
      req.jti = payload.jti;
      next();
    });
  } catch {
    logger.warn({ method: req.method, path: req.path, error: 'Invalid or expired token' });
    logAuditEvent({ action: 'auth_failed', path: req.path, reason: 'Invalid or expired token', timestamp: new Date().toISOString() }).catch(() => {});
    sendUnauthorized(res, 'Invalid or expired token');
  }
}

/**
 * Middleware guard that restricts access to a single role.
 *
 * Usage: router.get('/admin-only', requireRole('admin'), handler)
 *
 * Returns 401 if no valid token is present.
 * Returns 403 if the token's role does not match.
 * All 401 and 403 responses are persisted to the audit trail.
 */
export function requireRole(...allowedRoles: string[]) {
  // The first role is the "primary" one — used for the X-API-Key path (API keys
  // are scoped to a single role) and for audit/log messages. Additional roles
  // (e.g. 'admin') are accepted on the JWT path only.
  const role = allowedRoles[0];
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // ── X-API-Key path ──────────────────────────────────────────────────────────
    const apiKeyHeader = req.headers['x-api-key'];
    if (apiKeyHeader && typeof apiKeyHeader === 'string') {
      if ((await authenticateApiKey(req, res, role)) !== 'ok') return;
      next();
      return;
    }

    // ── JWT Bearer path ─────────────────────────────────────────────────────────
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      logger.warn({ method: req.method, path: req.path, error: 'Missing auth token', requiredRole: role });
      logAuditEvent({ action: 'auth_failed', path: req.path, reason: 'Missing auth token', requiredRole: role, timestamp: new Date().toISOString() }).catch(() => {});
      sendUnauthorized(res, 'Missing auth token');
      return;
    }

    try {
      const token = header.slice(7);
      const payload = verifyToken(token);

      if (!payload.role || !allowedRoles.includes(payload.role)) {
        logger.warn({
          method: req.method,
          path: req.path,
          error: 'Insufficient permissions',
          requiredRole: role,
          providedRole: payload.role,
        });
        logAuditEvent({ action: 'auth_forbidden', path: req.path, reason: 'Insufficient permissions', requiredRole: role, timestamp: new Date().toISOString() }).catch(() => {});
        sendForbidden(res, 'Insufficient permissions', { requiredRole: role, providedRole: payload.role });
        return;
      }

      isTokenRevoked(payload.jti).then((revoked) => {
        if (revoked) {
          logger.warn({ method: req.method, path: req.path, error: 'Token revoked', requiredRole: role });
          sendUnauthorized(res, 'Token has been revoked');
          return;
        }
        req.account = payload.sub;
        req.role = payload.role;
        req.jti = payload.jti;
        next();
      }).catch(() => {
        req.account = payload.sub;
        req.role = payload.role;
        req.jti = payload.jti;
        next();
      });
    } catch {
      logger.warn({ method: req.method, path: req.path, error: 'Invalid or expired token', requiredRole: role });
      logAuditEvent({ action: 'auth_failed', path: req.path, reason: 'Invalid or expired token', requiredRole: role, timestamp: new Date().toISOString() }).catch(() => {});
      sendUnauthorized(res, 'Invalid or expired token');
    }
  };
}

/**
 * Middleware that extracts a JWT if present but never blocks unauthenticated requests.
 * Sets req.account and req.role when a valid Bearer token is found; otherwise no-ops.
 */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    try {
      const payload = verifyToken(header.slice(7));
      req.account = payload.sub;
      req.role = payload.role;
      req.jti = payload.jti;
    } catch {
      // Invalid/expired token — treat the request as anonymous
    }
  }
  next();
}

/**
 * Middleware that enforces an API-key scope on the current request.
 *
 * Only applies to requests authenticated with an X-API-Key that carries an
 * explicit (restricted) scope list. Requests authenticated with a JWT, and
 * legacy/unrestricted API keys (`req.apiKeyScopes === null`), always pass —
 * scope enforcement must not change pre-existing behavior.
 *
 * Place AFTER requireRole/requireAuth so req.apiKeyScopes is populated.
 *
 * Usage: router.post('/route', requireRole('scout'), requireApiKeyScope('write:contacts'), handler)
 *
 * Returns 403 with `reason.requiredScope` + `reason.providedScopes` on denial.
 */
export function requireApiKeyScope(scope: ApiKeyScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.apiKeyScopes === undefined || req.apiKeyScopes === null) {
      // JWT-authenticated or legacy/unrestricted API key — no scope gate.
      next();
      return;
    }
    if (hasApiKeyScope(req.apiKeyScopes, scope)) {
      next();
      return;
    }
    logger.warn({
      method: req.method,
      path: req.path,
      error: 'Insufficient permissions',
      requiredScope: scope,
      providedScopes: req.apiKeyScopes,
    });
    logAuditEvent({
      action: 'auth_forbidden',
      path: req.path,
      reason: 'Missing API key scope',
      requiredScope: scope,
      timestamp: new Date().toISOString(),
    }).catch(() => {});
    sendForbidden(res, 'Insufficient permissions', {
      requiredScope: scope,
      providedScopes: req.apiKeyScopes,
    });
  };
}

/**
 * Middleware guard that allows access to any one of the specified roles.
 * Use this when a route should be accessible to multiple roles.
 *
 * Usage: router.get('/route', requireRoles('admin', 'validator'), handler)
 *
 * Returns 401 if no valid token is present.
 * Returns 403 if the token's role is not in the allowed list.
 */
export function requireRoles(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      sendUnauthorized(res, 'Missing auth token');
      return;
    }
    try {
      const payload = verifyToken(header.slice(7));
      if (!payload.role || !roles.includes(payload.role)) {
        sendForbidden(res, 'Insufficient permissions');
        return;
      }
      req.account = payload.sub;
      req.role = payload.role;
      req.jti = payload.jti;
      next();
    } catch {
      sendUnauthorized(res, 'Invalid or expired token');
    }
  };
}
